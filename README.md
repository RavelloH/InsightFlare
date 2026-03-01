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

## 快速开始

1. 安装依赖

```bash
npm ci
```

2. 创建 D1（首次）

```bash
npm run cf:d1:create
```

3. 修改 `apps/dashboard/wrangler.toml`

- 填入 `[[d1_databases]]` 的 `database_id`
- 按需开启 `[[r2_buckets]]`

4. 设置 Secret（至少一个）

```bash
npm run cf:secret:daily-salt
```

可选：

```bash
npm run cf:secret:admin-token
npm run cf:secret:dashboard-password
```

5. 本地构建验证

```bash
npm run mono:build
```

6. 部署

```bash
npm run mono:deploy
```

## Cloudflare Git 集成（重要）

如果在 Cloudflare 控制台使用 Git 自动部署，请设置：

- Build command: `npm run ci:build`
- Deploy command: `npm run ci:deploy`

不要在 monorepo 根目录直接用 `npx wrangler deploy`。

## 常用命令

- 本地开发：`npm run dev`
- 预部署 dry-run：`npm run mono:deploy:dry-run`
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
