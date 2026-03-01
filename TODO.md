# InsightFlare 实现 TODO（v0）

## Phase 0 - 项目初始化

- [x] 初始化 monorepo（建议 `apps/dashboard` + `apps/edge` + `packages/shared`）
- [x] 配置 `wrangler.toml`：Worker、Durable Object、D1、Analytics Engine、R2（可选）绑定
- [x] 建立环境变量与 Secret 规范（`DAILY_SALT_SECRET`、JWT secret、WebSocket auth key）
- [x] 建立 migration 流程（D1 schema versioning）
- [x] 建立基础 CI（lint + typecheck + unit test）

验收：

- [x] 本地可一键启动 Worker 与 Next.js
- [x] Cloudflare 绑定项可通过健康检查接口读取

## Phase 1 - 采集链路 MVP（Worker + DO）

- [x] `GET /script.js` 动态脚本分发
- [x] 按 `request.cf.isEUCountry` 注入 `IS_EU_MODE` 并区分缓存键
- [x] 客户端采集：首次上报 + SPA 路由变化 + hidden/unload Beacon
- [x] 生成不可预测存储键（基于站点域名短哈希）
- [x] Worker 采集端点：快速返回 + `waitUntil` 转发 DO（JSON payload）
- [x] Durable Object 事件规范化（CF 元数据 + UA 解析 + 客户端字段）
- [x] EU 模式下服务端计算 `visitorId/sessionId`，忽略客户端同名字段
- [x] EU 模式会话切分固定 30 分钟（无活动超时）
- [x] DO 并行执行：内存缓冲 / Analytics Engine / WebSocket / Alarm 检查
- [x] Alarm（10 分钟）批量刷入 D1

验收：

- [ ] 单次 pageview 可在 Analytics Engine 与 D1 查到
- [ ] EU 模式下浏览器不写本地 ID，服务端可稳定生成会话
- [ ] 峰值压测下采集接口 P95 延迟不受 D1 写入影响

## Phase 2 - D1 数据模型与查询 API

- [x] 建表：`users`、`teams`、`team_members`、`sites`、`configs`
- [x] 建表：`pageviews`（明细）、`pageviews_archive_hourly`（归档）
- [x] 明细保留策略落地：`pageviews` 保留 `0-365` 天
- [x] 添加核心索引（`site_id + event_at` 等）
- [x] 查询 API：概览、趋势、来源、页面、国家、设备
- [x] 查询 API：会话明细、访客明细（权限受限）
- [x] 公开查询 API 脱敏（不返回 query/hash 详情、访客轨迹、bot 安全特征、详细 referrer URL）
- [x] 多站点过滤与 team 级权限校验

验收：

- [ ] 近 90 天趋势查询可秒级响应
- [ ] API 层完成 team/site 隔离

## Phase 3 - 前端 Dashboard（Next.js + shadcn/ui）

- [x] 鉴权（Next.js Proxy）
- [x] 多租户模型 UI：团队切换、站点切换、成员管理
- [x] 统计总览页（PV/UV/Session/Bounce/Duration）
- [x] 页面、来源、地区、设备维度图表
- [x] 实时面板：WebSocket 订阅 DO 推送
- [x] 配置页：站点配置、隐私配置、公开页开关
- [x] 公开站点页面（只读）
- [x] 公开页脱敏展示：仅聚合统计，不展示 query/hash 明细与访客级行为链
- [x] 公开页来源展示：仅 referrer 域名级聚合，不展示完整 URL

验收：

- [ ] 新用户可完成“创建团队 -> 创建站点 -> 获取脚本 -> 看到数据”全流程
- [ ] 实时面板可持续接收并渲染事件流

## Phase 4 - 归档系统（热归档 + 冷归档）

- [x] 每小时 Cron 任务框架与分布式锁
- [x] 热归档：聚合 365 天外明细到小时归档表
- [x] 冷归档：导出 Parquet 到 R2（可选）
- [ ] R2 自适应合并策略实现：
- [ ] 最近 24h：每小时 1 文件
- [ ] 最近 7d：每天 1 文件
- [ ] 最近 30d：每周 1 文件
- [ ] 最近 1y：每月 1 文件
- [ ] 1y 以上：每年 1 文件
- [x] 冷归档确认后删除 D1 源明细（带 7 天安全滞后）
- [ ] 失败重试与断点续跑

验收：

- [ ] 归档任务不会处理当前未结束时间桶
- [ ] 数据删除前可追溯到已归档对象与校验记录

## Phase 5 - 精确模式（R2 + 浏览器本地 SQL）

- [x] 客户端按时间范围计算需下载的 Parquet 列表
- [x] 浏览器侧接入 `duckdb-wasm`
- [ ] 合并 Analytics Engine + D1 + R2 查询结果
- [ ] 精确模式性能优化（并发下载、列裁剪、结果缓存）

验收：

- [ ] 365 天外明细可按筛选条件查询
- [ ] 大时间范围查询可在可接受时延内完成

## Phase 6 - 稳定性与安全

- [ ] 幂等去重：事件 `eventId` 机制
- [ ] 采样与限流策略（防刷、防重放）
- [ ] 可观察性：日志、指标、告警（Worker/DO/Cron）
- [ ] 数据最小化与脱敏（IP 哈希/截断可配置）
- [ ] 字段级权限矩阵（私有后台 vs 公开页）自动化测试
- [ ] 备份与恢复演练（D1 + R2）

验收：

- [ ] 关键错误有可追踪告警与重试策略
- [ ] 隐私配置可一键切换并生效

## 优先级建议

1. 先完成 Phase 1 + Phase 2（能稳定采集和查询）。
2. 再完成 Phase 3（可用产品界面）。
3. 最后推进 Phase 4 + Phase 5（长期成本与超长周期查询）。

## 关键技术决策（已确认）

- [x] D1 明细表保留策略：固定 `0-365`
- [x] EU 会话窗口：固定 `30min`
- [x] R2 精确模式引擎：`duckdb-wasm`
- [x] 公开站点脱敏范围：隐藏 query/hash 详情、访客轨迹、bot 分数与安全特征、详细 referrer URL
