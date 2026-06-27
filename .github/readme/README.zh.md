# InsightFlare

<!-- auto-readme-i18n-switcher start -->
| [English](/.github/readme/README.en.md) | 中文 |
<!-- auto-readme-i18n-switcher end -->

> 功能强大、隐私友好的开源网站访问分析工具，完全运行于 Cloudflare 上。

Demo: [http://insight-demo.ravelloh.com](http://insight-demo.ravelloh.com/)

![ScreenShot](/.github/screenshot/001.webp)

完全符合 GDPR，无任何 Cookie ，无需用户同意即可合法追踪访问数据。独创的智能跟踪强度机制，可根据不同地区的隐私法规自动调整访客标识的持久性，最大程度兼顾数据完整性与用户隐私保护。

前端统计脚本 SDK 在 gzip 压缩后仅约 3 KB，通过 Cloudflare 全球 CDN 分发，访问性能优秀。SDK 自带自定义事件追踪（`data-insightflare-event`）和性能指标追踪。

多语言的仪表盘使用前所未有的可视化效果，让你对访问数据了如指掌。独创的地名多语言翻译功能，自动翻译全球 95% 以上的地名，让你轻松了解访客的地理分布。

Cloudflare 的免费额度可提供每日 10 万次访问的免费追踪，结合边缘计算带来极佳性能。

我们不存储原始 IP 信息，依靠 Cloudflare 进行地理位置解析，在保护用户隐私的同时提供极高精准度的分析。

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

## 特性

### 完整的访问维度追踪

![001](/.github/screenshot/001.webp)
![002](/.github/screenshot/002.webp)
![003](/.github/screenshot/003.webp)

### 实时查看访客情况

![004](/.github/screenshot/004.webp)
![005](/.github/screenshot/005.webp)

### 分页面查看访问情况

![006](/.github/screenshot/006.webp)

### 追踪访客的真实访问性能

![007](/.github/screenshot/007.webp)
![008](/.github/screenshot/008.webp)
![009](/.github/screenshot/009.webp)

### 对比各个来源的访问质量

![010](/.github/screenshot/010.webp)
![011](/.github/screenshot/011.webp)
![012](/.github/screenshot/012.webp)

### 追踪 UTM 活动效果

![013](/.github/screenshot/013.webp)
![014](/.github/screenshot/014.webp)

### 记录并分析自定义事件

![015](/.github/screenshot/015.webp)
![016](/.github/screenshot/016.webp)
![017](/.github/screenshot/017.webp)

### 洞察每一次会话

![018](/.github/screenshot/018.webp)
![019](/.github/screenshot/019.webp)
![020](/.github/screenshot/020.webp)
![021](/.github/screenshot/021.webp)

### 了解你的每一位访客

![022](/.github/screenshot/022.webp)
![023](/.github/screenshot/023.webp)

### 追踪站点的回访情况

![024](/.github/screenshot/024.webp)
![025](/.github/screenshot/025.webp)

### 了解访客的地理分布与市场情报

![026](/.github/screenshot/026.webp)
![027](/.github/screenshot/027.webp)
![028](/.github/screenshot/028.webp)

### 查看访客的设备情况

![029](/.github/screenshot/029.webp)
![030](/.github/screenshot/030.webp)
![031](/.github/screenshot/031.webp)

### 了解用户的浏览器及其能力

![032](/.github/screenshot/032.webp)
![033](/.github/screenshot/033.webp)
![034](/.github/screenshot/034.webp)
![035](/.github/screenshot/035.webp)
![036](/.github/screenshot/036.webp)

### 随时调整你的追踪设置，无需修改前端 SDK

![037](/.github/screenshot/037.webp)
![038](/.github/screenshot/038.webp)

### 为团队协作而设计

![039](/.github/screenshot/039.webp)
![040](/.github/screenshot/040.webp)

### 轻松了解系统的运行状况

![041](/.github/screenshot/041.webp)
![042](/.github/screenshot/042.webp)

### 完整的多语言翻译

![043](/.github/screenshot/043.webp)
![044](/.github/screenshot/044.webp)

---

## 进阶配置

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

<!-- 5. 元素进入视口时触发一次 -->
<section
  data-insightflare-event="pricing_viewed"
  data-insightflare-event-trigger="enterviewport"
  data-insightflare-event-plan="pro"
>
  ...
</section>
```

## 技术栈

| 层   | 技术                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------- |
| 前端 | Next.js 16, React 19, Tailwind CSS 4, Radix UI, shadcn, Recharts, deck.gl, maplibre-gl, Motion |
| 后端 | Cloudflare Workers, Durable Objects, D1, R2, KV                                                |
| 构建 | OpenNext for Cloudflare, Wrangler 4, TypeScript 5                                              |

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
2. 安装依赖 : `npm install`
3. 创建本地数据库 : `npm run d1:migrate:local`
4. 设置环境变量：（参照 `.dev.vars.example`）
5. 运行开发服务器 : `npm run dev`

（设置环境变量 `NEXT_PUBLIC_DEMO_MODE=1`，将使开发服务器会自动启用 Demo 模式，使用前端模拟数据用于测试 UI 界面。）

## 常用命令

| 命令                              | 用途                                           |
| --------------------------------- | ---------------------------------------------- |
| `npm run dev`                     | 本地开发仪表板                                 |
| `npm run check`                   | 一键执行 typecheck + lint + format + i18n + test + spec 校验 |
| `npm run typecheck`               | TypeScript 类型检查                            |
| `npm run lint` / `lint:fix`       | ESLint                                         |
| `npm run format` / `format:check` | Prettier                                       |
| `npm run check:i18n`              | 校验翻译键的完整性                             |
| `npm run d1:migrate:local`        | 本地 D1 迁移                                   |
| `npm run d1:migrate:remote`       | 线上 D1 迁移                                   |
| `npm run d1:migration:create`     | 新建迁移文件                                   |
| `npm run cf:tail`                 | 查看线上 Worker 日志                           |

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
