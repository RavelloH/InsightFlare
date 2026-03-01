# InsightFlare

InsightFlare 是运行在 Cloudflare 上的开源访问分析系统

## 功能

- 动态 `GET /script.js`（按 `request.cf.isEUCountry` 切换 EU 模式）
- 客户端事件采集：首屏、路由变化、隐藏/离开上报
- `POST /collect` 快速返回，异步转发 Durable Object
- Durable Object 并行写入：内存缓冲、Analytics Engine、WebSocket、Alarm
- Alarm 批量落盘 D1
- 每小时归档：热归档（D1 小时聚合）+ 冷归档（可选 R2 Parquet）
- Dashboard：多团队/多站点管理、公开脱敏页面、DuckDB-WASM 精确查询
- Parquet 文件查询支持 `HTTP Range Requests`

## 架构说明

- 单应用：根目录 Next.js（OpenNext + Cloudflare Worker）
- 单配置：仅使用根目录 `wrangler.toml`
- 采集、查询、管理接口均通过 Next.js Route Handlers 提供：
  - `/script.js`
  - `/collect`
  - `/api/private/*`
  - `/api/public/*`
  - `/healthz`
- `cf-worker.js` 仅负责：
  - 导出 Durable Object 类
  - 透传 `/admin/ws`
  - 执行定时归档任务

## 快速开始

1. 安装依赖

```bash
npm ci
```

2. 创建 D1（首次）

```bash
npm run cf:d1:create
```

3. 修改根目录 `wrangler.toml`

- 填入 `[[d1_databases]]` 的 `database_id`
- 按需开启 `[[r2_buckets]]`

4. 设置 Secret（至少一个）

```bash
npm run cf:secret:daily-salt
```

可选：

```bash
npm run cf:secret:admin-token
npm run cf:secret:bootstrap-admin-password
npm run cf:secret:session-secret
```

5. 本地构建验证

```bash
npm run cf:build
```

6. 部署

```bash
npm run cf:deploy
```

## Cloudflare Git 集成（重要）

如果在 Cloudflare 控制台使用 Git 自动部署，请设置：

- Build command: `npm run ci:build`
- Deploy command: `npm run ci:deploy`

不要跳过 `prebuild` 直接部署，否则 D1 迁移不会自动执行。

## 常用命令

- 本地开发：`npm run dev`
- 预部署 dry-run：`npm run cf:deploy:dry-run`
- CI dry-run：`npm run ci:deploy:dry-run`
- 查看线上日志：`npm run cf:tail`

## 关键配置

- `SESSION_WINDOW_MINUTES`：会话窗口（默认 `30`）
- `SCRIPT_CACHE_TTL_SECONDS`：`/script.js` 缓存秒数
- `REQUIRE_TEAM_MEMBERSHIP`：
  - `0` 不强制成员校验（默认）
  - `1` 强制校验私有查询接口的 `x-user-id` 是否属于站点团队
- `PARQUET_WASM_URL`：Parquet wasm 下载地址

## 注意事项

- 生产建议使用 Linux/WSL/CI 构建（OpenNext 官方建议）
- 当前 `Next 16 + @opennextjs/cloudflare 1.17` 组合下，鉴权需使用 `middleware.ts`（`proxy.ts` 会触发 Node middleware 限制）
