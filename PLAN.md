# InsightFlare 方案计划（v0）

## 1. 目标与边界

InsightFlare 目标是构建一个部署在 Cloudflare 全家桶上的开源访问分析系统，能力对标 Google Analytics/Umami，重点包含：

- 边缘侧低延迟采集（Worker + Durable Object）
- 分层存储（Analytics Engine + D1 + 可选 R2）
- 多租户模型（用户/团队/站点）
- 可实时监控（Durable Object WebSocket）
- 可归档与可回溯（热归档 + 冷归档 + Parquet）

## 2. 可行性评估（结论）

当前方案总体合理，核心设计方向可落地：

- 用 Worker + Durable Object 做实时采集与缓冲，适合高并发写入和快速响应。
- Analytics Engine 负责近实时/近 90 天查询，D1 承担中期明细与归档索引，R2 承担长期低成本存储，分层明确。
- EU 模式下禁用客户端持久 ID、改服务端动态计算，符合隐私导向。
- 归档分热/冷两阶段，先聚合再迁移，能降低在线查询压力。

核心技术决策已确认，可直接进入实现阶段（见第 12 节“已确认决策”）。

## 3. 总体架构

1. `GET /script.js`
- Worker 动态生成脚本（根据 `request.cf.isEUCountry` 注入 `IS_EU_MODE`）。
- 脚本可缓存，但应区分 EU/非 EU 版本缓存键。

2. 客户端上报
- 首次加载立即上报 `pageview`。
- 监听 `history.pushState`、`replaceState`、`popstate`、`hashchange`，路由变化继续上报。
- `visibilitychange`（hidden）与 `pagehide` / `beforeunload`（Beacon）上报停留信息。

3. Worker 接入层
- 接收采集请求后立即返回 `204`（或 `202`）。
- 用 `ctx.waitUntil(...)` 异步把请求 JSON 转发给 Durable Object，不阻塞用户请求。

4. Durable Object 处理层
- 解析 CF 元数据 + 客户端数据 + UA 解析结果，构建标准事件对象。
- 并行执行：
  - 写入 DO 内存缓冲
  - 写入 Analytics Engine
  - 推送 WebSocket 给后台
  - 如无激活 alarm，则设置 10 分钟 alarm

5. Alarm 批处理
- 每次触发将内存缓冲批量写入 D1。
- 成功后清空已落库批次。

6. Cron 归档层（每小时）
- 热归档：将 D1 明细中 365 天前数据按“小时桶”聚合到归档表。
- 冷归档：将已热归档范围的明细转存 R2（可选）并删除 D1 源明细。

## 4. ID 与隐私策略

## 4.1 非 EU 模式

- `visitorId`：首次脚本运行写入 `localStorage`（UUID）。
- `sessionId`：写入 `sessionStorage`（UUID）。
- 键名：使用站点域名短哈希，降低可预测性。

## 4.2 EU 模式

- 脚本中 `visitorId` / `sessionId` 置空，不在浏览器持久化。
- 服务端动态计算：
  - `visitorId = sha256(cf-connection-ip + userAgent + dailySalt)`
  - `sessionId = sha256(visitorId + sessionWindowKey)`

## 4.3 Salt 与会话窗口（已定）

- `dailySalt` 放入 Worker Secret，按天轮换（可叠加固定主密钥 + 日期派生）。
- EU 模式会话窗口固定为 30 分钟无活动切断（服务端动态计算）。
- 非 EU 模式优先使用客户端 `sessionStorage` 会话 ID；若缺失则回退服务端 30 分钟窗口计算。

## 5. 事件标准模型（采集字段）

单条事件应至少包含：

- 租户维度：`teamId`、`siteId`
- 时间维度：`eventAt`、`receivedAt`、`hourBucket`
- 请求维度：`hostname`、`pathname`、`query`、`hash`、`title`
- 来源维度：`referer`、`refererHost`、`utm*`
- 访客维度：`visitorId`、`sessionId`
- 设备维度：`uaRaw`、`browser`、`browserVersion`、`os`、`osVersion`、`deviceType`
- 屏幕与语言：`screenWidth`、`screenHeight`、`language`、`timezone`
- 网络地理（来自 `request.cf`）：`asOrganization`、`bot(score, verifiedBot)`、`country`、`isEUCountry`、`city`、`continent`、`latitude`、`longitude`、`postalCode`、`metroCode`、`region`、`regionCode`、`timezone`、`colo`
- 连接与头：`ip`（`cf-connection-ip`）、`userAgent`
- 行为：`eventType`（`pageview`/`route_change`/`hidden`/`unload`）、`durationMs`

## 6. 存储分层与职责

1. Analytics Engine
- 存最近 90 天详细数据，用于极速查询与实时看板。

2. D1（明细表 + 归档表 + 业务表）
- 明细表：固定存 0-365 天（作为持久化存储与分析引擎补偿数据源）。
- 归档表：存 365 天外小时级聚合趋势。
- 业务表：用户/团队/站点/成员关系/配置等。

3. R2（可选）
- 存 365 天外明细 Parquet，供“精确模式”客户端拉取后本地 SQL 查询。

## 7. D1 数据模型（建议）

核心业务表：

- `users`
- `teams`
- `team_members`
- `sites`
- `site_members`（可选，若权限仅团队级可省）
- `configs`（`key`, `value(json)`, `createdAt`, `updatedAt`）

分析表：

- `pageviews`（明细，含多租户字段与索引）
- `pageviews_archive_hourly`（小时聚合归档）

关键索引建议：

- `pageviews(site_id, event_at)`
- `pageviews(site_id, session_id, event_at)`
- `pageviews(site_id, visitor_id, event_at)`
- `pageviews(site_id, pathname, event_at)`
- `pageviews_archive_hourly(site_id, hour_bucket)`

## 8. 查询策略

## 8.1 趋势查询

- 0-90 天：Analytics Engine
- 90-365 天：Analytics Engine + D1 明细（按窗口补齐）
- 365+：Analytics Engine + D1 明细 + D1 归档

365 天外以趋势聚合为主，不保证任意维度细筛。

## 8.2 明细查询

- 0-90 天：Analytics Engine
- 90-365 天：Analytics Engine + D1 明细
- 365+（精确模式）：Analytics Engine + D1 明细 + R2 Parquet（浏览器本地 SQL）

## 9. 归档策略（热/冷）

## 9.1 触发频率

- Cron 每小时执行一次。

## 9.2 时间边界规则

- 只处理“已完整结束”的时间桶，不处理当前未结束小时/天。
- 使用绝对时间边界（UTC）计算：
  - 小时归档上界 = 当前整点前一小时结束
  - 天级文件上界 = 昨日 23:59:59.999

## 9.3 热归档

- 处理 `event_at < now - 365d` 且未归档小时桶。
- 聚合写入 `pageviews_archive_hourly`。
- 热归档阶段不删明细。

## 9.4 冷归档

- 将已热归档对应的明细导出 Parquet 到 R2（若启用）。
- 执行分层合并策略（24h/7d/30d/1y）。
- 确认 R2 与归档元数据成功后删除 D1 明细原文。
- 删除动作设置安全滞后（如 7 天）并幂等可重试。

## 10. 前端与权限模型（Next.js + shadcn/ui）

- Next.js App Router + Middleware 做鉴权与站点访问控制。
- 支持：
  - 多账户（用户）
  - 多团队（Team）
  - 团队下多站点（Site）
  - 站点配置（采集开关、公开页、隐私策略）
  - 公共统计页（可选匿名访问）
- 公开站点脱敏规则（已定）：
  - 隐藏 `query/hash` 详情
  - 隐藏独立访客轨迹（visitor/session 粒度行为链）
  - 隐藏 bot 分数与安全特征字段
  - 隐藏详细 `referer` URL（仅允许域名级聚合）
- 后台看板可通过 WebSocket 订阅 Durable Object 实时数据流。

## 11. 非功能要求

- 高吞吐：采集写路径不阻塞请求返回。
- 幂等性：事件具备 `eventId`，防止 Beacon 重发重复统计。
- 可观察性：Worker/DO/Cron 全链路日志与错误告警。
- 安全：最小化存储 IP（可哈希或截断），配置可选匿名化。
- 可迁移性：D1 schema 采用 migration 管理，归档任务支持断点续跑。

## 12. 已确认决策

1. D1 明细保留策略
- 固定为 `0-365` 天；Analytics Engine 用于加速，不作为唯一存储。

2. EU 会话切分窗口
- 固定 `30` 分钟无活动切分。

3. EU 判断字段命名
- 实现按 Cloudflare 官方字段 `request.cf.isEUCountry`。

4. R2 精确模式客户端
- 确认采用 `duckdb-wasm`。

5. 公开站点脱敏范围
- 隐藏 `query/hash` 详情、独立访客轨迹、bot 分数与安全特征、详细 referrer URL。
