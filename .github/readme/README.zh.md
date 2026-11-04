<div align="center">

# InsightFlare

### 数据属于你，分析运行在自己的 Cloudflare 上。

兼顾隐私与分析深度的开源网站统计平台：实时流量、访客旅程、转化漏斗，以及 AI Agent 数据分析。

[**在线体验**](https://insight-demo.ravelloh.com/) &nbsp;·&nbsp; [**一键部署到 Cloudflare**](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FRavelloH%2FInsightFlare) &nbsp;·&nbsp; [**源代码**](https://github.com/RavelloH/InsightFlare)

[![GitHub stars](https://img.shields.io/github/stars/RavelloH/InsightFlare?style=flat-square&logo=github)](https://github.com/RavelloH/InsightFlare/stargazers) [![Latest release](https://img.shields.io/github/v/release/RavelloH/InsightFlare?style=flat-square)](https://github.com/RavelloH/InsightFlare/releases) [![License: MIT](https://img.shields.io/github/license/RavelloH/InsightFlare?style=flat-square)](/LICENSE)

<!-- auto-readme-i18n-switcher start -->
| [English](/.github/readme/README.en.md) | [日本語](/.github/readme/README.ja.md) | [中文（台灣）](/.github/readme/README.zh-tw.md) | 中文 |
<!-- auto-readme-i18n-switcher end -->

</div>

<a href="https://insight-demo.ravelloh.com/"><img src="/.github/screenshot/001.webp" alt="InsightFlare analytics dashboard" width="100%"></a>

## 为什么选择 InsightFlare？

不止于访问量统计，也不必将分析数据交给第三方平台。InsightFlare 运行在你自己的 Cloudflare 账户中，将流量、访客行为和运行观测整合在一个仪表盘里。

- **自己的基础设施，自己的数据。** 基于 Cloudflare Workers、D1 和 Durable Objects 自托管，无需注册第三方分析 SaaS。
- **看懂访客行为。** 分析会话、访问旅程、漏斗、自定义事件、UTM 活动和流量来源质量。
- **实时掌握网站动态。** 观察实时访问、性能指标、地理分布、浏览器和设备。
- **辨别无效流量。** 通过机器人防护和异常请求观测，区分纯粹的访问量与真实有价值的访问。
- **让 AI Agent 帮忙分析。** 借助 Skills 入口和具备权限控制的 API，自然语言查询访问数据。
- **从小规模开始，按需扩展。** 支持一键部署、多站点与团队、可选的 R2 归档及灵活配置。

**隐私与费用说明：** 追踪器采用无 Cookie 设计，不保存原始 IP。具体法律合规要求与 Cloudflare 费用取决于部署配置、流量和适用地区。

## 界面预览

精选真实界面截图，点击即可查看原图。

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/004.webp"><img src="/.github/screenshot/004.webp" alt="实时访问" width="100%"><br><strong>实时访问</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/018.webp"><img src="/.github/screenshot/018.webp" alt="访客会话" width="100%"><br><strong>访客会话</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/054.webp"><img src="/.github/screenshot/054.webp" alt="事件漏斗" width="100%"><br><strong>事件漏斗</strong></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/010.webp"><img src="/.github/screenshot/010.webp" alt="来源分析" width="100%"><br><strong>来源分析</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/026.webp"><img src="/.github/screenshot/026.webp" alt="地理分布" width="100%"><br><strong>地理分布</strong></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/058.webp"><img src="/.github/screenshot/058.webp" alt="机器人观测" width="100%"><br><strong>机器人观测</strong></a></td>
  </tr>
</table>

## 完整功能预览

与 NeutralPress 一样，直接展示真实界面截图。按功能分类排列，点击缩略图即可查看原图。

### 流量概览与来源分析

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/001.webp"><img src="/.github/screenshot/001.webp" width="100%" alt="完整的访问维度追踪" title="完整的访问维度追踪"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/002.webp"><img src="/.github/screenshot/002.webp" width="100%" alt="完整的访问维度追踪" title="完整的访问维度追踪"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/003.webp"><img src="/.github/screenshot/003.webp" width="100%" alt="完整的访问维度追踪" title="完整的访问维度追踪"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/004.webp"><img src="/.github/screenshot/004.webp" width="100%" alt="实时查看访客情况" title="实时查看访客情况"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/005.webp"><img src="/.github/screenshot/005.webp" width="100%" alt="实时查看访客情况" title="实时查看访客情况"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/006.webp"><img src="/.github/screenshot/006.webp" width="100%" alt="分页面查看访问情况" title="分页面查看访问情况"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/007.webp"><img src="/.github/screenshot/007.webp" width="100%" alt="追踪访客的真实访问性能" title="追踪访客的真实访问性能"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/008.webp"><img src="/.github/screenshot/008.webp" width="100%" alt="追踪访客的真实访问性能" title="追踪访客的真实访问性能"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/009.webp"><img src="/.github/screenshot/009.webp" width="100%" alt="追踪访客的真实访问性能" title="追踪访客的真实访问性能"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/010.webp"><img src="/.github/screenshot/010.webp" width="100%" alt="对比各个来源的访问质量" title="对比各个来源的访问质量"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/011.webp"><img src="/.github/screenshot/011.webp" width="100%" alt="对比各个来源的访问质量" title="对比各个来源的访问质量"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/012.webp"><img src="/.github/screenshot/012.webp" width="100%" alt="对比各个来源的访问质量" title="对比各个来源的访问质量"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/013.webp"><img src="/.github/screenshot/013.webp" width="100%" alt="追踪 UTM 活动效果" title="追踪 UTM 活动效果"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/014.webp"><img src="/.github/screenshot/014.webp" width="100%" alt="追踪 UTM 活动效果" title="追踪 UTM 活动效果"></a></td>
    <td width="33%"></td>
  </tr>
</table>

### 事件、会话与访客旅程

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/015.webp"><img src="/.github/screenshot/015.webp" width="100%" alt="记录并分析自定义事件" title="记录并分析自定义事件"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/016.webp"><img src="/.github/screenshot/016.webp" width="100%" alt="记录并分析自定义事件" title="记录并分析自定义事件"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/017.webp"><img src="/.github/screenshot/017.webp" width="100%" alt="记录并分析自定义事件" title="记录并分析自定义事件"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/018.webp"><img src="/.github/screenshot/018.webp" width="100%" alt="洞察每一次会话" title="洞察每一次会话"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/019.webp"><img src="/.github/screenshot/019.webp" width="100%" alt="洞察每一次会话" title="洞察每一次会话"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/020.webp"><img src="/.github/screenshot/020.webp" width="100%" alt="洞察每一次会话" title="洞察每一次会话"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/021.webp"><img src="/.github/screenshot/021.webp" width="100%" alt="洞察每一次会话" title="洞察每一次会话"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/022.webp"><img src="/.github/screenshot/022.webp" width="100%" alt="了解你的每一位访客" title="了解你的每一位访客"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/023.webp"><img src="/.github/screenshot/023.webp" width="100%" alt="了解你的每一位访客" title="了解你的每一位访客"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/024.webp"><img src="/.github/screenshot/024.webp" width="100%" alt="追踪站点的回访情况" title="追踪站点的回访情况"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/025.webp"><img src="/.github/screenshot/025.webp" width="100%" alt="追踪站点的回访情况" title="追踪站点的回访情况"></a></td>
    <td width="33%"></td>
  </tr>
</table>

### 受众、设备与地理分析

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/026.webp"><img src="/.github/screenshot/026.webp" width="100%" alt="了解访客的地理分布与市场情报" title="了解访客的地理分布与市场情报"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/027.webp"><img src="/.github/screenshot/027.webp" width="100%" alt="了解访客的地理分布与市场情报" title="了解访客的地理分布与市场情报"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/028.webp"><img src="/.github/screenshot/028.webp" width="100%" alt="了解访客的地理分布与市场情报" title="了解访客的地理分布与市场情报"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/029.webp"><img src="/.github/screenshot/029.webp" width="100%" alt="查看访客的设备情况" title="查看访客的设备情况"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/030.webp"><img src="/.github/screenshot/030.webp" width="100%" alt="查看访客的设备情况" title="查看访客的设备情况"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/031.webp"><img src="/.github/screenshot/031.webp" width="100%" alt="查看访客的设备情况" title="查看访客的设备情况"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/032.webp"><img src="/.github/screenshot/032.webp" width="100%" alt="了解用户的浏览器及其能力" title="了解用户的浏览器及其能力"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/033.webp"><img src="/.github/screenshot/033.webp" width="100%" alt="了解用户的浏览器及其能力" title="了解用户的浏览器及其能力"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/034.webp"><img src="/.github/screenshot/034.webp" width="100%" alt="了解用户的浏览器及其能力" title="了解用户的浏览器及其能力"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/035.webp"><img src="/.github/screenshot/035.webp" width="100%" alt="了解用户的浏览器及其能力" title="了解用户的浏览器及其能力"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/036.webp"><img src="/.github/screenshot/036.webp" width="100%" alt="了解用户的浏览器及其能力" title="了解用户的浏览器及其能力"></a></td>
    <td width="33%"></td>
  </tr>
</table>

### 设置、团队协作与分享

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/037.webp"><img src="/.github/screenshot/037.webp" width="100%" alt="随时调整你的追踪设置，无需修改前端 SDK" title="随时调整你的追踪设置，无需修改前端 SDK"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/038.webp"><img src="/.github/screenshot/038.webp" width="100%" alt="随时调整你的追踪设置，无需修改前端 SDK" title="随时调整你的追踪设置，无需修改前端 SDK"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/039.webp"><img src="/.github/screenshot/039.webp" width="100%" alt="为团队协作而设计" title="为团队协作而设计"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/040.webp"><img src="/.github/screenshot/040.webp" width="100%" alt="为团队协作而设计" title="为团队协作而设计"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/041.webp"><img src="/.github/screenshot/041.webp" width="100%" alt="轻松了解系统的运行状况" title="轻松了解系统的运行状况"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/042.webp"><img src="/.github/screenshot/042.webp" width="100%" alt="轻松了解系统的运行状况" title="轻松了解系统的运行状况"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/043.webp"><img src="/.github/screenshot/043.webp" width="100%" alt="完整的多语言翻译" title="完整的多语言翻译"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/044.webp"><img src="/.github/screenshot/044.webp" width="100%" alt="完整的多语言翻译" title="完整的多语言翻译"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/045.webp"><img src="/.github/screenshot/045.webp" width="100%" alt="公开分享系统" title="公开分享系统"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/046.webp"><img src="/.github/screenshot/046.webp" width="100%" alt="公开分享系统" title="公开分享系统"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/047.webp"><img src="/.github/screenshot/047.webp" width="100%" alt="作用域分明的 API 系统" title="作用域分明的 API 系统"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/048.webp"><img src="/.github/screenshot/048.webp" width="100%" alt="定时任务" title="定时任务"></a></td>
  </tr>
</table>

### 深度事件分析与转化漏斗

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/049.webp"><img src="/.github/screenshot/049.webp" width="100%" alt="对 JSON 格式的自定义事件进行深度分析" title="对 JSON 格式的自定义事件进行深度分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/050.webp"><img src="/.github/screenshot/050.webp" width="100%" alt="对 JSON 格式的自定义事件进行深度分析" title="对 JSON 格式的自定义事件进行深度分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/051.webp"><img src="/.github/screenshot/051.webp" width="100%" alt="对 JSON 格式的自定义事件进行深度分析" title="对 JSON 格式的自定义事件进行深度分析"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/052.webp"><img src="/.github/screenshot/052.webp" width="100%" alt="对 JSON 格式的自定义事件进行深度分析" title="对 JSON 格式的自定义事件进行深度分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/053.webp"><img src="/.github/screenshot/053.webp" width="100%" alt="对 JSON 格式的自定义事件进行深度分析" title="对 JSON 格式的自定义事件进行深度分析"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/054.webp"><img src="/.github/screenshot/054.webp" width="100%" alt="使用漏斗来分析访问与事件" title="使用漏斗来分析访问与事件"></a></td>
  </tr>
</table>

### 运行监控、通知与机器人防护

<table>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/055.webp"><img src="/.github/screenshot/055.webp" width="100%" alt="定时 / 按条件接收通知邮件" title="定时 / 按条件接收通知邮件"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/056.webp"><img src="/.github/screenshot/056.webp" width="100%" alt="定时 / 按条件接收通知邮件" title="定时 / 按条件接收通知邮件"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/057.webp"><img src="/.github/screenshot/057.webp" width="100%" alt="定时 / 按条件接收通知邮件" title="定时 / 按条件接收通知邮件"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/058.webp"><img src="/.github/screenshot/058.webp" width="100%" alt="多维度的机器人防护与观测系统" title="多维度的机器人防护与观测系统"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/059.webp"><img src="/.github/screenshot/059.webp" width="100%" alt="多维度的机器人防护与观测系统" title="多维度的机器人防护与观测系统"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/060.webp"><img src="/.github/screenshot/060.webp" width="100%" alt="多维度的机器人防护与观测系统" title="多维度的机器人防护与观测系统"></a></td>
  </tr>
  <tr>
    <td width="33%" align="center"><a href="/.github/screenshot/061.webp"><img src="/.github/screenshot/061.webp" width="100%" alt="多维度的机器人防护与观测系统" title="多维度的机器人防护与观测系统"></a></td>
    <td width="33%" align="center"><a href="/.github/screenshot/062.webp"><img src="/.github/screenshot/062.webp" width="100%" alt="多维度的机器人防护与观测系统" title="多维度的机器人防护与观测系统"></a></td>
    <td width="33%"></td>
  </tr>
</table>

---

## 快速开始

只需点击以下按钮：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FRavelloH%2FInsightFlare)

Cloudflare 会自动 Clone 这个仓库、创建并绑定所需要的资源。其中，你需要填写下面两个 Secret：

| 名称                       | 用途                                                       |
| -------------------------- | ---------------------------------------------              |
| `MAIN_SECRET`              | 根密钥，用于派生访客隐私 salt、会话签名和 API Key 哈希密钥 |
| `BOOTSTRAP_ADMIN_PASSWORD` | 初始化管理员密码                                           |

`MAIN_SECRET` 用于安全相关的功能，必须是长度超过 16 的随机字符串。可以通过访问 [https://random.ravelloh.com/str/32](https://random.ravelloh.com/str/32) 来生成一个随机字符串。（刷新页面可以得到一个新的字符串）

`BOOTSTRAP_ADMIN_PASSWORD` 是你的默认账号管理员密码。你需要使用 `admin` 账号和这个密码登录仪表板，此后可以在个人设置页面修改用户名和密码。

填写完毕后，等待 3 分钟让项目部署完毕，你就可以登录到仪表盘并开始追踪访问数据了。此外，你可以在项目的设置页面自定义其域名。默认的访问地址是 `https://insightflare.<your-cloudflare-username>.workers.dev`

---

## 进阶配置

### 启用分析引擎来进行深度分析

Analytics Engine 是 InsightFlare 可选的高吞吐分析层，用于将请求观测以及未来的流量、事件分析投影与主数据库解耦：

- `REQUEST_ANALYTICS` → 请求观测和异常流量
- `TRAFFIC_ANALYTICS` → 采样后的流量事实
- `EVENT_ANALYTICS` → 采样后的自定义事件事实

但是，这需要您手动开启 Analytics Engine。您只需要前往 [Cloudflare Dashboard](
https://dash.cloudflare.com/?to=/:account/workers/analytics-engine) 并点击右侧的“启用”按钮即可。之后部署 InsightFlare 时，系统会自动将 Analytics Engine 与您的 Cloudflare 账户绑定。

启用后，InsightFlare 会写入以上三个数据集。当前版本的“请求观测”页面已经使用新的 `REQUEST_ANALYTICS` 数据集查询；`TRAFFIC_ANALYTICS` 和 `EVENT_ANALYTICS` 会持续积累数据，供后续 Analytics Engine Provider 使用。读取数据集需要 API Token，请在系统设置中填写 Cloudflare Account ID 和具备“账户分析”读取权限的 API Token。Reader 配置仍保存在主数据库 D1 中，详见 InsightFlare 后台设置页面的“教程”按钮。

### 接入 AI Agents 进行分析

我们开放了用于 AI Agents 的 Skills，您可以选择将 InsightFlare 接入您的 Agents，例如 OpenClaw、Codex、Claude Code 等, 让 Agents 能够直接访问 InsightFlare 的数据，进行分析和报告生成。  
请直接发送下面的指令给您的 Agent，您需要域名换成您部署的 InsightFlare 实例。您的 Agents 会指引您前往仪表盘为其创建一个专用 API 密钥，便于其访问 InsightFlare 的数据。

```txt
阅读 https://<您的 InsightFlare 域名>/.well-known/skills.json，接入这个访问分析系统，并指引我进行授权。
```

随后，您可以以任意自然语言向 Agent 提问，例如：

```txt
“上个月，我的站点的访问情况如何？访问量最高的站点中，访客大都是来自哪里的？哪些页面最受欢迎？”
```

### 使用 Cloudflare 变量覆盖 Wrangler 配置

在 Cloudflare 的构建环境中，可以通过「变量和密钥」覆盖 `wrangler.toml` 中需要因部署而变化的配置。`build:pre` 会在部署前读取这些变量并写入当前 Wrangler 配置，随后 `wrangler deploy` 会使用覆盖后的配置。

常用变量：

| 名称                                       | 覆盖目标                              |
| -------------------------------------      | ------------------------------------- |
| `INSIGHTFLARE_WORKER_NAME`                 | Worker 名称                           |
| `INSIGHTFLARE_D1_DATABASE`                 | D1 数据库名称                         |
| `INSIGHTFLARE_D1_DATABASE_ID`              | `DB` 绑定的 D1 数据库 ID              |
| `INSIGHTFLARE_SITE_SETTINGS_KV_ID`         | `SITE_SETTINGS_KV` 绑定的 KV 命名空间 |
| `INSIGHTFLARE_ARCHIVE_BUCKET_NAME`         | `ARCHIVE_BUCKET` 绑定的 R2 存储桶     |
| `INSIGHTFLARE_ARCHIVE_PREVIEW_BUCKET_NAME` | R2 预览存储桶                         |
| `SESSION_WINDOW_MINUTES`                   | 会话窗口分钟数                        |
| `SCRIPT_CACHE_TTL_SECONDS`                 | `/script.js` CDN 缓存秒数             |
| `PARQUET_WASM_URL`                         | Parquet wasm 下载地址                 |
| `INSIGHTFLARE_EDGE_URL`                    | InsightFlare 服务基准 URL             |

也可以使用 `INSIGHTFLARE_VAR_变量名` 写入任意 `[vars]` 项。例如 `INSIGHTFLARE_VAR_FEATURE_FLAG=1` 会生成 `FEATURE_FLAG = "1"`。如果使用 `--env production`，可使用 `INSIGHTFLARE_PRODUCTION_D1_DATABASE_ID`、`INSIGHTFLARE_PRODUCTION_VAR_INSIGHTFLARE_EDGE_URL` 这类环境专属变量覆盖 `[env.production]` 下的配置。

### 配置 R2 存储桶用于冷归档

只有需要启用冷归档到 R2 时，才需要手动创建 R2 bucket。默认情况下，访问数据保存 1 年，超时的数据将被压缩保存（可查看访问趋势、数据，但无法进行筛选）。R2 是可选项，Deploy Button 默认不会要求绑定 R2。启用 R2 后，可对超出 1 年的数据进行详细查询。

在 Cloudflare 内创建名为 `insightflare-archive` 的存储桶。并在 `wrangler.toml` 中取消 `[[r2_buckets]]` 的注释即可，如下所示：

```toml
[[r2_buckets]]
binding = "ARCHIVE_BUCKET"
bucket_name = "insightflare-archive"
preview_bucket_name = "insightflare-archive-preview"
```

### 保持更新

我们创立了开创性的 GitHub App 自动更新系统，带给你最简单的更新体验。

保持更新仅需要两步：

1. 为你的仓库安装 GitHub App（只需一次，请 **仅选择你部署的 InsightFlare 的仓库**）: [Install InsightFlare Sync](https://github.com/apps/insightflare-sync/installations/new)
2. 当上游存在更新时，会自动向你的仓库提交一个 PR。你只需要合并这个请求即可。

_想要让自己的项目也能方便的同步到下游？实现细节：[RavelloH/upstream-sync-bot](https://github.com/RavelloH/upstream-sync-bot)（开源模板）+ [RavelloH/InsightFlare-Bot](https://github.com/RavelloH/InsightFlare-Bot)（本项目的 bot 实例）。_

### 自定义事件上报

InsightFlare 的前端 SDK 支持以手动调用的方式上报自定义事件，或者通过 DOM 属性自动上报事件。

#### 手动调用

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

可用的方法：

- `track(eventName, eventData?)`：上报一个自定义事件。
- `trackOnce(eventName, eventData?)`：同一个事件名在当前页面生命周期内只上报一次。
- `setGlobalProperties(props)`：为后续事件追加公共字段。
- `clearGlobalProperties()`：清除公共字段。

#### 用户身份识别

使用 `identify` 将当前访问与登录用户关联，同时保留原有的匿名访客边界：

```html
<script>
  window.insightflare.identify("user-123", { name: "Alice" });
</script>
```

用户登录后调用 `identify`，即可将当前及后续访问按用户统一分析。首次页面访问前调用也受支持。用户退出登录时调用 `reset()`，结束当前身份、创建新的匿名访客边界，并避免后续事件继承旧账号：

```js
window.insightflare.reset();
window.insightflare.identify("user-456", { name: "Bob" });
```

切换账号前请先调用 `reset()`。单独调用 `identify("user-456")` 不会创建新的访客边界。

#### DOM 属性自动上报

```html
<!-- 1. 默认点击触发 -->
<button data-insightflare-event="signup_click">立即注册</button>
<!-- 这会上报：{ eventName: "signup_click" } -->

<!-- 2. 点击触发，并通过 data-insightflare-event-* 附加字段 -->
<button
  data-insightflare-event="signup_click"
  data-insightflare-event-plan="pro"
  data-insightflare-event-source="pricing"
>
  立即注册
</button>
<!-- 这会上报：{ eventName: "signup_click", eventData: { plan: "pro", source: "pricing" } } -->

<!-- 3. 点击触发，并通过 JSON 附加字段 -->
<button
  data-insightflare-event="signup_click"
  data-insightflare-event-data='{"plan":"pro","source":"pricing"}'
>
  立即注册
</button>
<!-- 这会上报：{ eventName: "signup_click", eventData: { plan: "pro", source: "pricing" } } -->

<!-- 4. 表单 submit 触发 -->
<form
  data-insightflare-event="contact_submit"
  data-insightflare-event-trigger="submit"
  data-insightflare-event-data='{"plan":"pro","source":"landing"}'
>
  ...
</form>

```

## 技术栈

| 层   | 技术                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 前端 | TanStack Start 1、TanStack Router、Vite 8、React 19、Tailwind CSS 4、Radix UI、shadcn、Recharts、deck.gl、maplibre-gl、Motion |
| 后端 | Cloudflare Workers、Durable Objects、D1、R2、KV                                                                               |
| 构建 | Cloudflare Vite Plugin、Wrangler 4、TypeScript 5                                                                              |

---

## 手动部署

不使用部署按钮，请使用下面的方法来部署：

1. Fork 或者 Clone 这个仓库到你的 GitHub 账号下
2. 在 Cloudflare 中创建以下资源：
   - D1 数据库
   - KV Namespace
   - R2 存储桶（可选，仅冷归档到 R2 时需要）
3. 编辑 `wrangler.toml`，将 D1 和 KV 资源绑定到 Worker 上
4. 填写环境变量（参照 `.dev.vars.example`）
5. 在 Worker 页面导入这个仓库

### 本地开发

1. 克隆这个仓库到本地 : `git clone https://github.com/RavelloH/InsightFlare`
2. 安装依赖 : `pnpm install`
3. 创建本地数据库 : `pnpm run db:migrate:local`
4. 设置环境变量：（参照 `.dev.vars.example`）
5. 运行开发服务器 : `pnpm run dev`

`pnpm run dev:ui` 会以 Demo 模式启动 Vite 开发服务器，使用前端模拟数据进行 UI 测试。若通过 `pnpm run dev` 启动，可设置 `DEMO_MODE=1` 启用 Demo 模式。

## 常用命令

| 命令                                          | 用途                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm run dev`                                 | Vite + Cloudflare Workers 本地开发（使用 `http://localhost:3000`）      |
| `pnpm run dev:ui`                              | 以 Demo 模式启动 Vite 仪表板开发服务器                                  |
| `pnpm run preview:local`                       | 使用本地资源构建并启动 Wrangler 预览                                    |
| `pnpm run build`                               | Cloudflare 托管构建入口                                                 |
| `pnpm run build:local`                         | 本地预检 + 本地 D1 迁移 + 构建                                          |
| `pnpm run build:demo`                          | 无资源绑定的 Demo 构建                                                  |
| `pnpm run deploy`                              | Cloudflare 托管部署入口                                                 |
| `pnpm run publish`                             | 在允许的 Cloudflare 环境中构建并主动发布                                |
| `pnpm run publish:demo`                        | 构建并发布 Demo Worker                                                  |
| `pnpm run check`                               | 自动修复格式和 lint，并执行 build + typecheck + i18n + test + spec 检查 |
| `pnpm run check:verify`                        | 严格执行完整检查，不自动修复                                            |
| `pnpm run typecheck`                           | TypeScript 类型检查                                                     |
| `pnpm run lint` / `lint:fix`                   | ESLint                                                                  |
| `pnpm run format` / `format:check`             | Prettier                                                                |
| `pnpm run check:i18n`                          | 校验翻译键的完整性                                                      |
| `pnpm run db:migrate:local`                    | 本地 D1 迁移                                                            |
| `pnpm run db:migrate:cf`                       | Cloudflare D1 迁移                                                      |
| `pnpm run db:migration:create`                 | 新建迁移文件                                                            |
| `pnpm run ops:secret:main`                     | 设置 `MAIN_SECRET` Worker Secret                                        |
| `pnpm run ops:secret:bootstrap-admin-password` | 设置初始化管理员密码 Secret                                             |
| `pnpm run ops:tail`                            | 查看线上 Worker 日志                                                    |

---

## 关键配置项

| 名称                                 | 含义                                  |
| ------------------------------------ | ---------------------------           |
| `SESSION_WINDOW_MINUTES`             | 会话窗口分钟数（默认 `30`）           |
| `SCRIPT_CACHE_TTL_SECONDS`           | `/script.js` CDN 缓存秒数             |
| `PARQUET_WASM_URL`                   | Parquet wasm 下载地址                 |
| `INSIGHTFLARE_EDGE_URL`              | InsightFlare 服务基准 URL             |
| `MAIN_SECRET`（Secret）              | 派生安全密钥的根密钥                  |
| `BOOTSTRAP_ADMIN_PASSWORD`（Secret） | 初始化管理员密码                      |
| `DAILY_SALT_SECRET`（Secret）        | `MAIN_SECRET` 未设置时的兼容 fallback |
| `DASHBOARD_SESSION_SECRET`（Secret） | 可选的会话签名覆盖项                  |

---

## License

[MIT](/LICENSE) © 2026 RavelloH
