# InsightFlare

在 Cloudflare 上运行的下一代访问分析系统。通过 Durable Objects 实现高吞吐写入，借助 D1/R2 分层存储实现长期保留，并坚持隐私优先的数据采集策略。

## 结构

- `apps/edge`：采集/查询核心逻辑（被单体 Worker 复用）
- `apps/dashboard`：Next.js 管理面板 + 单体 Worker 入口（`cf-worker.js`）
- `packages/shared`：共享载荷接口定义
- `scripts/prebuild.ts`：构建前自动执行 `wrangler d1 migrations apply`

部署形态为真单体：Cloudflare 上只部署一个 Worker（Dashboard + Edge API + Durable Object）。

## 部署前准备

1. 环境要求

- Node.js 22+
- Cloudflare 账号（Workers + D1 + Analytics Engine；可选 R2）
- 已登录 Wrangler：`npm exec wrangler login`

2. 安装依赖

```bash
npm ci
```

3. 首次创建 D1（仅第一次需要）

```bash
npm run cf:d1:create
```

执行后把返回的 `database_id` 填入 [`apps/dashboard/wrangler.toml`](apps/dashboard/wrangler.toml) 的 `[[d1_databases]]`。

4. 检查单体配置文件

- Worker 主入口：`main = "./cf-worker.js"`
- D1 迁移目录：`migrations_dir = "../edge/migrations"`
- 可选 R2：按注释开启 `[[r2_buckets]]`
- 可选 wasm 地址：`PARQUET_WASM_URL`

## 一键部署（推荐）

1. 设置必需密钥（至少要设置 `DAILY_SALT_SECRET`）

```bash
npm run cf:secret:daily-salt
```

2. 可选密钥

```bash
npm run cf:secret:admin-token
npm run cf:secret:dashboard-password
```

3. 部署前自检（远端迁移 + 打包 + dry-run）

```bash
npm run mono:deploy:dry-run
```

4. 正式部署（远端迁移 + 打包 + 发布）

```bash
npm run mono:deploy
```

5. 查看实时日志

```bash
npm run cf:tail
```

## 本地开发

```bash
npm run dev
```

Dashboard 默认在 `http://localhost:3000`。  
单体生产构建（本地迁移 + OpenNext build）：

```bash
npm run mono:build
```

## 自动迁移说明

`mono:*` 和 `build` 流程会调用 `scripts/prebuild.ts`，自动执行：

```bash
wrangler d1 migrations apply insightflare --config <wrangler.toml> --local|--remote
```

支持参数：

- `--config`、`--target`、`--database`、`--env`、`--auto-migrate`

支持环境变量：

- `INSIGHTFLARE_AUTO_MIGRATE=0`
- `INSIGHTFLARE_MIGRATION_TARGET=local|remote`
- `INSIGHTFLARE_D1_DATABASE=insightflare`
- `INSIGHTFLARE_WRANGLER_CONFIG=/abs/path/wrangler.toml`
- `INSIGHTFLARE_ENV=production`

## 部署验证清单

部署完成后建议按顺序验证：

1. 健康检查：`GET /healthz`
2. 登录 Dashboard：`/login`
3. 注入脚本站点访问后，确认 `/collect` 有写入
4. Dashboard 概览页是否出现实时数据
5. 若开启归档，检查 `archive_objects` 与 R2 对象写入

## 生产建议

- 生产部署建议在 Linux/WSL/CI 执行（OpenNext 官方建议）
- `workers_dev = true` 仅用于快速测试，正式可绑定自定义域
- 建议把 `DASHBOARD_PASSWORD` 与 `ADMIN_API_TOKEN` 使用 Secret 管理，不放明文变量
- 当前 `Next 16 + @opennextjs/cloudflare 1.17` 组合下，`proxy.ts` 会触发 Node middleware 限制，需暂时使用 `middleware.ts`

## 当前 MVP

- 动态 `/script.js`，支持 EU 模式切换
- 客户端事件采集：pageview、路由变化、隐藏/卸载 beacon
- Worker `/collect` 通过 `waitUntil` 异步转发到 Durable Object
- Durable Object 并行摄取：
  - 内存缓冲
  - 写入 Analytics Engine
  - 推送 WebSocket 实时消息
  - 调度 alarm
- alarm 批量落盘 D1
- 每小时归档流水线：热归档（小时聚合）+ 冷归档（R2 Parquet 对象 + 元数据 + 明细清理）
- Dashboard 提供代理鉴权、多团队/多站点管理、配置页、公开统计页与 DuckDB-WASM 精确查询页
- 精确查询链路支持 `HTTP Range Requests`（DuckDB 远程 Parquet + Worker/Proxy 透传 `Range`/`HEAD`）
- 健康检查接口（含绑定状态）：`GET /healthz`

## 查询 API（第二阶段）

私有接口（`/api/private/*`）支持管理员查询。  
当设置 `ADMIN_API_TOKEN` 后，请携带以下任一方式：

- `Authorization: Bearer <token>`
- `x-admin-token: <token>`

可选的严格团队隔离：

- 设置 `REQUIRE_TEAM_MEMBERSHIP=1`
- 在私有查询请求中传入 `x-user-id: <user-id>`
- Worker 会在 D1 的 `team_members` 中校验该用户是否属于目标站点所在团队

私有查询接口：

- `GET /api/private/overview?siteId=...&from=...&to=...`
- `GET /api/private/trend?siteId=...&from=...&to=...&interval=hour|day`
- `GET /api/private/pages?siteId=...&from=...&to=...&limit=30&details=1`
- `GET /api/private/referrers?siteId=...&from=...&to=...&limit=30&fullUrl=1`
- `GET /api/private/events?siteId=...&from=...&to=...&limit=50`
- `GET /api/private/sessions?siteId=...&from=...&to=...&limit=50`
- `GET /api/private/visitors?siteId=...&from=...&to=...&limit=50`

私有管理接口：

- `GET|POST /api/private/admin/teams`
- `GET|POST|PATCH /api/private/admin/sites`
- `GET|POST /api/private/admin/members`
- `GET|POST /api/private/admin/site-config`
- `GET /api/private/admin/script-snippet?siteId=...`
- `GET /api/private/archive/manifest?siteId=...&from=...&to=...`
- `GET /api/private/archive/file?key=...`

公开接口（`/api/public/{slug}/*`）始终会执行隐私脱敏：

- `GET /api/public/{slug}/overview?from=...&to=...`
- `GET /api/public/{slug}/trend?from=...&to=...&interval=hour|day`
- `GET /api/public/{slug}/pages?from=...&to=...&limit=30`
- `GET /api/public/{slug}/referrers?from=...&to=...&limit=30`

公开模式脱敏规则：

- 隐藏 Query/Hash 细节
- 隐藏访客/会话轨迹数据
- 隐藏 Bot 评分与安全特征
- 隐藏完整 Referrer URL（仅域名级别）

## Dashboard 鉴权与环境变量

Dashboard（`apps/dashboard`）通过 Cookie Session 代理守卫保护 `/app/*`：

- `DASHBOARD_PASSWORD`：登录密码（默认 `insightflare`）
- `INSIGHTFLARE_EDGE_URL`：Edge API 基础地址（默认 `http://127.0.0.1:8787`）
- `INSIGHTFLARE_ADMIN_API_TOKEN`：私有 API Token（通过 `x-admin-token` 透传）
- `INSIGHTFLARE_DEFAULT_SITE_ID`：Dashboard 查询表单默认站点 ID
- `NEXT_PUBLIC_INSIGHTFLARE_WS_URL`：实时 WebSocket 基础地址（例如 `http://127.0.0.1:8787`）
- `NEXT_PUBLIC_INSIGHTFLARE_WS_TOKEN`：`/admin/ws` 可选 token 查询参数

Dashboard 页面：

- `/app`：概览、趋势与实时流
- `/app/teams`：团队/站点/成员管理与安装片段
- `/app/config`：站点公开与隐私脱敏配置
- `/app/precision`：DuckDB-WASM 精确模式（基于 Parquet 归档对象本地查询）
- `/public/{slug}`：公开脱敏统计页
