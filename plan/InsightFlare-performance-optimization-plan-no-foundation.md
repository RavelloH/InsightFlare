# InsightFlare 查询性能优化计划（No-Foundation 版）

> 状态：阶段性实施计划（部署前置修复与第一批 SQL 改写已完成）
> 日期：2026-08-14  
> 目标：在**不建设 Foundation、不引入新的 rollout/control/snapshot/projection 基础设施**的前提下，优先完成现有代码中已经有充分证据支持的查询与写入优化。  
> 依据：现有《InsightFlare 查询性能评估》的静态审查、24h/30d D1 Insights 生产数据，以及当前已部署的 Dashboard Cache / rows-read diagnostics / hourly rollup。

### 发布前置修复记录

以下问题已在性能优化工作开始前处理完成，本计划不再重复引入对应基础设施：

- Durable Object 部署 migration 历史已按 Cloudflare 现有生产状态修正。不得重新声明或重排已经应用的 `IngestDurableObject` SQLite migration；后续 DO migration 必须保持单调、追加且与线上历史一致。
- D1 migration `0034` 负责删除 `0033` 创建的 Foundation 表，属于独立的数据库迁移，不回退线上 D1 migration 历史。
- 分支覆盖率门槛已恢复到可通过状态。后续测试补充必须覆盖真实业务分支，不得降低 `vitest.config.ts` 中的全局阈值来“修复” CI。

---

## 1. 决策摘要

本轮明确**不做 Foundation**。

不实施以下内容：

- 不新增 `performance_rollout_controls` / audit / maintenance control tables。
- 不新增 DiagnosticsSampler Durable Object。
- 不新增通用 v2 router / shadow / enabled 状态机。
- 不新增 deployment manifest / bridge version / old-writer drain 框架。
- 不为 Journey 引入 snapshot 表、snapshot GC、签名 cursor 基础设施。
- 不为 scheduled-task 立即建设 projection / bridge / backfill / reconciliation 系统。
- 不因为优化需要而先建设一套独立“内部平台”。

本轮只做：

1. **现有 endpoint 的等价 SQL 改写。**
2. **删除明显的无界读取与重复扫描。**
3. **利用现有 cache、hourly rollup 和 D1 `meta.rows_read` 诊断能力。**
4. **减少明显的写放大。**
5. **只有在实测仍不达标时，才讨论新的表、索引或 projection。**

原则：

> 先把当前能直接优化的 80% 做完，再决定剩下的 20% 是否值得引入更复杂的基础设施。

---

## 2. 当前生产基线

以下数据来自现有生产 D1 Insights，应作为本轮优化的主要基线。

### 2.1 最高优先级读热点

| 路径 | 当前生产观测 | 结论 |
| --- | ---: | --- |
| Visitor detail / `querySessionsForDetailFromD1` | **3,833,408 rows read/次；4,948 ms/次** | P0，单次即可消耗接近 Free 日额度 |
| Scheduled-task admin `runGroupSelectSql` | **4,181,999 rows read/次；2,875 ms/次** | P0，管理页存在灾难级读放大 |
| Visitor list / `queryVisitorsFromD1` | **909,631 rows read/次；1,539 ms/次** | P0，相关子查询 fan-out 已被生产证实 |
| path + referrer overview | 常见 **36,407 rows/次**；最坏 **103,678 rows/次** | P1，函数谓词 + 全窗口聚合 |
| `COUNT(*) FROM scheduled_task_run_logs` | 近 24h **13,169 rows/次** | P1，日志增长后持续线性恶化 |
| Geo point grouping | **1,639 rows/次** | P2，不是当前主矛盾 |

### 2.2 已证明健康的路径

| 路径 | 当前生产观测 | 决策 |
| --- | ---: | --- |
| 单站点 hourly rollup | **270 rows/次；2.55 ms/次** | 保留并保护 |
| hourly rollup UPSERT | 30d 共 20,139 writes，耗时低 | 保留 |
| Dashboard Cache | Cache HIT 可返回 `rows-read=0` | 继续使用，但不把 HIT 当作 SQL 优化成果 |

### 2.3 写入热点

| 路径 | 30d 写入 | 结论 |
| --- | ---: | --- |
| visits 全列 UPSERT | **170,766 writes** | 最大写热点 |
| scheduled task log INSERT | **52,788 writes** | 日志写放大明显 |
| custom event 主记录 | 37,996 writes | 当前可接受 |
| custom event nodes/values | 45,177 writes | 后续观察 |

---

## 3. 本轮目标

### 3.1 核心目标

在不改变现有业务语义的前提下：

- 消除 Journey detail/list 的相关子查询 fan-out。
- 显著降低 scheduled-task admin 的重复 log count 与无条件全表 count。
- 减少 events/pages/dimensions 中同窗口的重复 raw scans。
- 避免将整个日期窗口原始 visits/events 拉回 Worker 后再聚合。
- 在历史数据兼容性证明通过后，让 path/referrer 等常用筛选使用规范化等值谓词。
- 减少无变化 visit flush 和不必要 task log 写入。
- 建立“每次操作的 Cloudflare 资源成本”验收方式。

### 3.2 明确非目标

本轮不承诺：

- 所有 Dashboard 查询都达到 O(1)。
- 所有查询都完全不读 raw visits。
- 立即建设完整 dimension rollup。
- 立即建设 team rollup。
- 立即解决任意全历史查询。
- 立即建立 FTS。
- 立即恢复大量 `visits` dimension indexes。
- 修改 Journey API contract、强制 90 天窗口或引入 `/v2`。
- 修改历史 analytics 的统计口径。

---

# 4. 实施顺序

---

## Phase 0：补齐最小诊断，不建设新基础设施

### 目标

只利用 Cloudflare 已有的 D1 Insights、Worker invocation/CPU 指标和当前响应头中的
`rows_read` 诊断，让后续每个改动都可以用生产数据验收。Phase 0 不是新的全量遥测系统。

### 修改

优先使用 D1 Insights 对以下 endpoint 做 baseline：

- Journey visitor list
- Journey session list
- Journey visitor detail
- Journey session detail
- Scheduled Tasks admin
- path/referrer overview
- Events detail / summary
- Pages / dimensions 高消耗 endpoint

记录范围以 Cloudflare 原生指标为准：

- Worker request、CPU time、wall time
- D1 query、rows read、rows written（D1 Insights 能提供的粒度）
- 请求窗口、部署版本、cache `hit | miss | bypass`

现有 `diagnostics.ts` 仅把部分 `.all()` 的 `rows_read` 聚合到响应头，并不持久化或
覆盖所有操作，也不天然提供完整的 route、fingerprint、query count 或 writes 明细。
因此本阶段不把这些字段列为必须新增的采集合同；优先使用 D1 Insights 和 Worker 原生
指标即可。

仅当某个 P0 查询无法由 D1 Insights 与现有 `rows_read` 响应头评估时，才允许增加
短期、管理员限定的诊断；必须有采样上限、TTL 和明确删除时间。禁止为 Phase 0
新增 D1/DO/KV/Analytics Engine 持久写入通道，也禁止记录 visitor ID、session ID、
完整 URL、SQL 参数、custom payload 或其他 PII。

### 关键规则

**只使用 Origin MISS 评价 SQL 优化。**

Cache HIT：

```text
rows_read = 0
```

只能说明缓存有效，不能说明 SQL 变便宜。

### 验收

Phase 0 本身不要求性能下降，只要求：

- 相关 endpoint 能从 D1 Insights 或现有响应头看到 rows-read。
- cache hit/miss 可区分。
- 改造前 baseline 可复现。
- 无新增持久遥测资源；临时管理员诊断按期删除。

---

# 5. Phase 1：P0 直接查询重构

## 5.1 Journey visitor/session detail

### 当前问题

生产最严重的 Journey detail 单次达到：

```text
3.83M rows read
4.95 s
```

根因：

- visitor detail 可读取 target 全历史。
- session 列表对每个 session 重复执行 first/last 查询。
- 每个 session 再执行 event count。
- 多个相关子查询会在过滤 CTE 上反复排序/扫描。
- 宽 visits 投影增加 D1/Worker 负担。

### 第一阶段只做“结果等价改写”

**不改变 API contract。**

不引入：

- 90d 默认限制
- v2 endpoint
- snapshot
- 新 cursor contract
- 截断语义

### SQL 改写

分别建立：

```text
target_visits
visitor_metrics
session_metrics
session_first
session_last
event_counts_by_session
```

原则：

1. 一次定位 target visits。
2. `session_metrics` 一次 `GROUP BY session_id`。
3. first/last 使用 set-based window ranking 或明确的 `MIN/MAX + JOIN`。
4. 同 timestamp 统一以 `visit_id` 作为 tie-break。
5. custom events 先按 session 聚合，再 JOIN。
6. 只 SELECT 返回所需字段。
7. 不在每个结果行内部执行独立 `ORDER BY ... LIMIT 1`。

### 语义兼容要求

必须逐字段保持：

- visitor/session 总数
- views
- duration
- first/last page
- first/last timestamp
- entry/exit
- event count
- active/terminal 状态
- 空 `session_id` 现有行为
- 当前 event source 的过滤边界

### 验收目标

以当前生产最坏查询为基线：

```text
3.83M rows read/次
```

第一阶段目标：

```text
< 500k rows read/次
```

理想目标：

```text
< 100k rows read/次
```

但不为了达到数字而改变旧 API 语义。

### 回滚

- 仅 SQL/TS 实现变化。
- 无 migration。
- 直接 Worker version rollback。
- 保留旧测试 fixture 用于结果对比。

---

## 5.2 Journey visitor/session list

### 当前问题

生产观测：

```text
909,631 rows read/次
1.54 s/次
```

主要问题同样是：

- per-group first/last scalar subquery
- event count fan-out
- 聚合/排序后才分页
- deep OFFSET

### 修改

第一步只消除 fan-out：

- visitor 和 session 分开建 set-based 聚合。
- first/last 一次产生。
- event counts 一次分组。
- 仅在最后结果集上排序。
- 保持现有 page/offset contract。

第二步才考虑：

- 将大 OFFSET 改 keyset cursor。

cursor 改动如果影响 API contract，应作为独立提交，不和 SQL rewrite 混在一起。

### 验收目标

当前：

```text
~910k rows read/次
```

目标：

```text
< 200k rows read/次
```

理想：

```text
< 100k
```

### Journey 共同验收门槛

Journey detail/list 的 SQL 改写不能只比较 SQL 文本或 CTE 名称。每个改动必须同时
通过：

1. `EXPLAIN QUERY PLAN`：确认过滤入口、索引使用、排序和 CTE materialize/scan
   次数没有因改写而恶化；SQLite 不保证仅因写成 CTE 就只扫描一次。
2. 等价 fixture parity：旧查询与新查询逐字段 diff，覆盖计数、first/last、排序、
   null/empty `session_id`、分页边界和 event source 过滤边界。
3. 相同 fixture 下的 rows-read、SQL 数和 wall time 对比；若成本下降但结果不等价，
   以正确性失败处理，不接受上线。

---

## 5.3 Scheduled Tasks admin

### 当前问题

生产：

```text
4.18M rows read/次
2.88 s/次
```

主要原因：

- 30 天 runs 先通过 CASE 计算 group key。
- 全量 `GROUP BY` 后才分页。
- group 查询对每个 group 执行相关日志计数，形成 fan-out。
- `admin-scheduled-tasks.ts` 中 health、stats、latest 已经是独立并行查询，不能把
  “拆分它们”当作本次性能收益来源。

### 本轮不做 projection

不创建：

- `scheduled_task_run_group_members`
- `scheduled_task_run_group_summaries`
- bridge writer
- backfill
- reconciliation

先做所有不需要 schema 的优化。

### 修改 A：删除或限定无条件日志全表 count

若当前实现仍存在以下查询，删除：

```sql
SELECT COUNT(*)
FROM scheduled_task_run_logs
```

替换为：

- `hasMore`
- 当前筛选窗口内 count
- 或不展示精确 total

这是确定性收益。

### 修改 B：在同一 SQL 中只统计当前页 groups 的日志

现状：

```text
所有 groups
  ×
相关 logs count
```

改为一个 SQL 内的分层 CTE：

1. `page_groups`：先完成 canonical group key、筛选、稳定排序和 `LIMIT/OFFSET`。
2. `page_runs`：只关联当前页 group 对应的 run rows。
3. `page_log_counts`：`JOIN scheduled_task_run_logs` 并按 `run_id`（或 group key）
   一次 `GROUP BY`，再回连当前页。

这样不会把所有 group 的日志计数带入分页前的查询，也不会依赖无上限的
`run_id IN (...)` 参数列表。若受现有 SQL 结构限制必须拆成多次查询，必须设置并
测试 run-id 数量上限，采用受控分块，并记录参数数量与 rows-read。

health、stats、latest 维持当前独立并行查询；本阶段只分别记录 fingerprint，避免
把已经存在的拆分误写成优化动作。

### 修改 D：限制 OFFSET

短期：

- 给 page/offset 设置最大深度。
- 超过阈值提示缩小时间/条件。

后续可单独迁移 keyset。

### 预期

由于 CASE + GROUP BY 仍可能扫描 30 天 runs，**本阶段不承诺 95–99%**。

但应显著移除：

- per-group log fan-out
- 全表日志 count
- 不必要附带统计

### 验收

当前：

```text
4.18M rows read/次
```

阶段目标：

```text
至少下降 50%
```

如果优化后仍：

```text
> 500k rows read/次
```

则记录为“直接 SQL 优化已到边界”，再单独讨论 projection；不提前建设 Foundation。

---

# 6. Phase 2：事件、页面、维度的重复扫描

## 6.1 Event detail / context cards

### 当前静态问题

事件详情一次请求可触发约：

```text
~27 SQL
```

多个 overview / trend / fields / context card 重复构建相同事件源。

### 修改

目标：

```text
27 SQL
→
3–6 SQL
```

做法：

- 请求级统一解析 event name → `event_name_id`。
- path → `path_id`。
- 共用一次 filtered event source。
- 多维结果通过：
  - `UNION ALL`
  - conditional aggregation
  - 或一次 request-scoped result reuse
  产生。
- 不把相同 filtered source 在 10+ 查询里重复构建。

### 验收

- SQL 数下降 ≥ 60%。
- origin MISS rows-read 下降 ≥ 50%。
- 所有 context card 与旧 fixture 完全一致。

---

## 6.2 Event summary

当前同一窗口可能：

- summary 一次
- name/path/title/hostname 多次
- overview 再重复多维扫描

修改为：

- 一次 filtered base
- 多维聚合尽量合并
- 每个维度只返回 Top-N

避免把完整事件集交给 Worker。

---

## 6.3 Pages tabs / filter options

### 当前问题

部分页面逻辑会：

```text
SELECT 日期窗口内大量 raw visits
→ Worker 构建 5–6 个 Map
→ Worker 排序/Top-N
```

### 修改

改为数据库侧：

```sql
GROUP BY
ORDER BY
LIMIT
```

每个 Tab 必须有明确 limit。

优先处理：

- pathname
- title
- hostname
- entry
- exit
- referrer
- browser
- device
- country
- filter options

### 验收

- Worker 接收行数下降 ≥ 80%。
- 同一窗口不再无界返回 raw visits。
- rows-read 至少不高于旧实现。
- Worker 内存和 response size 明显下降。

---

## 6.4 Geo

当前不是 P0。

只做：

- 合并同请求重复 country/region/city 查询。
- 避免同窗口重复 raw scans。
- 不立即建立 geo rollup。

只有长窗口再次进入高成本榜单时，再考虑 geo rollup。

---

# 7. Phase 3：path / referrer 等值查询优化

## 7.1 先改谓词，不先加索引

当前常见问题：

```sql
TRIM(...)
LOWER(...)
COALESCE(...)
```

包裹过滤列，导致现有索引难以有效 seek。

### 修改原则

如果 ingest 已经保证规范化，也不能直接假设历史数据满足同一约束。先对生产副本
统计大小写、首尾空白、空字符串和 NULL 的分布，并对旧谓词与候选新谓词做结果
diff；只有语义完全一致时，才改为：

```text
pathname
referrer_host
username
email
...
```

查询直接使用精确等值。

例如：

```sql
WHERE pathname = ?
```

而不是：

```sql
WHERE LOWER(TRIM(pathname)) = ?
```

### path/referrer overview

先做：

- 窄投影。
- 复用 filter。
- 合并重复聚合。
- 避免 50+ 列宽 CTE。
- 不立即创建 `(site_id,path,started_at)` 等高写索引。

### 验收

- 历史数据分布证明 canonical 列假设成立，或补充兼容分支。
- 旧/新谓词在代表性站点、窗口和 NULL/空白边界上结果一致。

生产当前：

```text
36k rows/read 常见
104k rows/read 最坏
```

目标：

```text
常见 < 20k
最坏 < 50k
```

如果精确谓词后仍高，再进入“索引候选”阶段。

---

# 8. Phase 4：Performance / percentile

当前 performance 页面存在：

- 五项性能指标重复 percentile 排序。
- routes/countries 重复同类窗口计算。
- 长窗口下 raw percentile 成本随样本数增长。

## 第一阶段直接优化

先做：

- 同窗口/同 metric source 共用。
- 合并能够合并的基础数据查询。
- 避免五次重复 filtered source。
- 短窗口继续 raw 精确 percentile。

## 第二阶段仅在仍超预算时考虑 rollup

候选：

```text
site/hour/metric histogram
```

或可合并 percentile sketch。

但它属于存储模型变化：

- 迟到数据
- merge
- 精度
- 回算
- 展示误差

必须单独设计，不作为本轮第一批提交的前置条件。

---

# 9. Phase 5：Notification 查询扇出

### 当前问题

每 30 分钟 notification tick：

- report 可能取 overview/pages/referrer
- threshold 每 condition 查询
- change 每 condition 查询前后窗口
- milestone 可扫长历史
- email config 对多个 recipient 重复读

### 修改

只做 invocation-scoped cache：

```text
(siteId, from, to, metric, filter)
```

相同 tick 内：

- 相同站点
- 相同窗口
- 相同 filters

只计算一次。

同时：

- email config 每 invocation 读一次。
- 去重相同 condition。
- condition / recipient 设置明确上限。
- 不跨 invocation 持久缓存敏感结果。

### 验收

目标：

- 重复条件场景 D1 reads 下降 40%+。
- email config read 由 N 降到 1/tick。
- 不新增 KV/DO 成本。

---

# 10. Phase 6：减少写放大

## 10.1 visits UPSERT

生产当前：

```text
25,103 次
170,766 writes
约 6.8 writes/次
```

### 目标

减少“值没有变化仍 UPDATE”的情况。

### 实施前必须先定义字段语义

字段分为：

1. 可直接等值比较。
2. 单调递增 / max。
3. 只允许首次设置。
4. 允许迟到更新。
5. 系统内部字段，不参与 guard。

特别注意：

- `last_activity_at`
- `ended_at`
- `finalized_at`
- duration
- performance metrics
- identity
- `ae_synced_at`
- `updated_at`

不能用一个简单“大对象 equality”草率决定跳过。

### 实施方式

先在测试/replay 中：

- 连续重复 flush。
- 乱序 perf update。
- identity 后到。
- session close 后重放。
- stale finalize。
- retry。

确认不会丢最终值后，再引入 `DO UPDATE ... WHERE` 差异 guard。

### 验收

目标：

```text
writes/visit flush 下降 ≥ 20%
```

同时：

- 最终 visit 行逐字段一致。
- 无状态倒退。
- 无 last_activity 丢失。
- 无 perf 迟到更新丢失。

---

## 10.2 Scheduled task logs

当前：

```text
13,197 inserts
52,788 writes
```

### 第一阶段

先处理读侧：

- 删除全表 count。
- 限定 UI 查询。

再评估写侧：

- debug/info 是否需要全部持久化。
- 是否可以每 run 限量。
- warn/error 保持全量。
- retention 是否过长。

不在没有幂等性证明前直接做复杂批量重试。

---

# 11. Phase 7：分页与无界明细

以下属于“现有可优化”，不依赖 Foundation。

## 11.1 Deep OFFSET

逐步将高成本列表迁移到稳定 keyset：

候选：

- events records
- Journey list
- task admin
- 其他大列表

每种排序必须定义：

```text
sortValue
secondarySort
primaryKey
direction
```

不能简单统一成 `(timestamp,id)`。

## 11.2 无界 detail

对于现有 legacy endpoint：

**本轮不静默改变语义。**

可以先：

- 给前端分页事件明细。
- 默认只请求第一页 timeline。
- summary 与 timeline 分开。
- 在不改变 summary 的情况下减少大数组返回。

如果未来要强制窗口限制，应单独做 API contract 变更。

---

# 12. Phase 8：索引候选，只在实测后实施

## 12.1 本轮禁止的做法

禁止第一反应恢复：

```text
(site_id,path,started_at)
(site_id,referrer,started_at)
(site_id,browser,started_at)
(site_id,country,started_at)
(site_id,device,started_at)
...
```

因为 `visits` 是高写热表。

## 12.2 可以低风险评估的索引

低写管理表可以优先：

```text
sites(team_id, created_at DESC)
analysis_definitions(site_id, kind, archived_at, created_at DESC)
```

其他候选必须满足：

1. 生产 fingerprint 仍超预算。
2. 查询谓词已经 canonical。
3. 有选择性数据。
4. 在生产副本有 EXPLAIN 证据。
5. rows-read 明显下降。
6. 写入 P95 / writes 增量在预算内。

## 12.3 冗余索引

确认 UNIQUE autoindex 后，可以删除重复：

- API key hash 显式 index
- account token hash 显式 index

但必须先验证实际生产 schema。

---

# 13. 保留与扩展现有 rollup

## 13.1 明确保留

`visit_hourly_rollups` 已被生产证明有效。

禁止因为“减少索引/表数量”而破坏：

```text
(site_id, hour_bucket)
```

读路径。

## 13.2 暂不立即创建的 rollup

以下先不做：

- team rollup
- geo rollup
- browser rollup
- country rollup
- path rollup
- visitor-label rollup
- performance histogram rollup

只有当对应 direct SQL 优化后仍超预算，再单独进入设计。

## 13.3 rollup 的触发门槛

某查询同时满足：

- 长窗口稳定进入 Top Reads。
- 直接 SQL 改写已完成。
- cache MISS 仍贵。
- 普通索引无法在不显著放大写入的情况下解决。
- 指标可接受预聚合语义。

才进入 rollup 设计。

---

# 14. Cloudflare 成本测试

本轮应同步建立简单、可落地的成本测试，但不需要 Foundation。

## 14.1 每个操作记录

至少：

```text
Worker requests
Worker CPU time
D1 queries
D1 rows read
D1 rows written
KV reads/writes
Analytics Engine writes/queries
DO requests / SQLite rows
R2 operations（如有）
```

## 14.2 关键场景

### 采集

- pageview lifecycle
- custom event
- visit close/finalize
- hourly rollup
- notification tick

### Dashboard

- overview 24h / 7d / 30d
- pages 30d
- technology 30d
- journey visitor list
- journey visitor detail
- scheduled task admin
- performance 30d
- events detail

## 14.3 Cold / Warm 分开

必须同时记录：

```text
Origin MISS Cost
Cache HIT Cost
```

不允许用高 cache hit rate 掩盖高 origin cost。

## 14.4 数据规模

至少：

```text
1k visits
10k visits
100k visits
```

检查成本增长趋势。

重点发现：

```text
O(N)
O(N × groups)
O(N × correlated-subquery-count)
```

而不仅是单次绝对值。

---

# 15. 每个独立 commit/阶段的统一验收模板

每个性能 commit 或阶段必须附：

## 修改前

```text
endpoint:
fingerprint:
dataset/window:
calls:
rows_read P50/P95:
wall P50/P95:
D1 query count:
response rows:
```

## 修改后

同一输入重复记录。

## 正确性

- fixture 完全一致
- 排序一致
- null/empty 一致
- pagination 一致
- event count 一致
- auth/RBAC 一致

## 成本

- Origin MISS 单独计算
- Cache HIT 单独计算
- writes 无异常上涨
- Worker CPU/内存无明显退化

---

# 16. 建议的独立 commit/阶段拆分

不要做一个“性能大重构”commit。每个阶段必须可独立验收、独立回滚，并在提交信息
或对应验收记录中附上 fixture parity、`EXPLAIN QUERY PLAN` 和 Origin MISS 对比结果。

推荐执行顺序固定为：Journey detail → Journey list → Scheduled Tasks group/log SQL
→ Events。每一步先完成结果等价验证与查询计划检查，再进行生产 Origin MISS 对比；
后续 Pages、canonical predicates、notification cache 和 UPSERT guard 不得插队到这
四个已证实热点之前。

建议的阶段：

### Commit 1
`perf: establish hot-route production baseline`

只整理并复现现有 D1 Insights、Worker 指标和 `rows_read` 响应头的基线；不新增全局
遥测包装器、持久化采集表、Durable Object、KV 或其他 Foundation 组件。若单个 P0
无法由现有指标评估，临时管理员诊断必须有采样上限、TTL 和删除日期。

### Commit 2
`perf: rewrite journey detail aggregation`（已完成）

只处理 Journey detail；必须附 `EXPLAIN QUERY PLAN`、旧/新 fixture parity 和 Origin
MISS 成本对比。

### Commit 3
`perf: rewrite journey list aggregation`（已完成）

只处理 Journey list；必须附 `EXPLAIN QUERY PLAN`、旧/新 fixture parity 和 Origin
MISS 成本对比。

### Commit 4
`perf: reduce scheduled task admin log scans`（已完成）

- 去全表 count
- 当前页 logs count
- 通过 `page_groups`、`page_runs`、`page_log_counts` 在同一 SQL 内完成当前页日志聚合
- 保持现有 health/stats/latest 独立并行查询；它们不是本阶段新增的性能改动

### Commit 5
`perf: consolidate event analytics scans`（已完成）

events detail/summary。

### Commit 6
`perf: move page and dimension aggregation into SQL`

消除 raw rows → JS 聚合。

### Commit 7
`perf: simplify canonical filters`

path/referrer/username/email 等精确谓词。

### Commit 8
`perf: reuse notification metrics per tick`（已完成）

以显式 invocation cache 复用相同 tick 内的 report/metric 查询和系统邮件配置；不跨
invocation 持久化敏感结果。

### Commit 9
`perf: reduce redundant visit upserts`

需完整 replay 后再提交。

### Commit 10+
只有实测仍需要时：

- targeted indexes
- new rollups
- projection
- API contract changes

---

# 17. 发布策略

本轮不建设自定义 rollout 系统。

使用现有能力：

1. CI / unit / E2E。
2. 生产副本 replay / fixture。
3. 部署 Worker 新版本。
4. 记录 deployment version / commit / timestamp。
5. 观察固定窗口 D1 Insights。
6. 出现语义或资源回归时直接 Worker version rollback。

对于没有 migration 的 SQL-only 改动：

```text
rollback = 旧 Worker version
```

足够。

对于未来带 migration 的修改：

- 单独设计。
- additive 优先。
- 不与纯查询优化混合。

---

# 18. 最终优先级

## P0：立即做

1. Journey visitor detail set-based rewrite。
2. Journey visitor/session list set-based rewrite。
3. Scheduled-task admin：
   - 删除全日志 count。
   - 当前页 group logs count。
   - 保持现有 health/stats/latest 并行拆分，只优化 group/log 查询。
4. 使用 D1 Insights 与现有 rows-read 响应头建立上述路径 baseline。
5. Event detail / summary 重复扫描合并。

## P1：紧接着做

6. Pages/filter options 不再无界拉 raw visits 到 JS。
7. path/referrer canonical predicate + 窄投影。
8. Notification invocation-scoped metric reuse。
9. Deep OFFSET 的 keyset 迁移。
10. visits UPSERT 差异写入研究与 replay。

## P2：前面完成后再决定

11. targeted composite indexes。
12. dimension rollup。
13. performance percentile rollup。
14. team rollup。
15. FTS / search projection。
16. scheduled-task projection。
17. Journey v2 / snapshot。

---

# 19. 成功标准

本轮完成后，至少满足：

### P0 查询

- 不再出现单次 **数百万 rows read** 的正常后台请求。
- Journey detail 从约 3.83M 明显下降。
- Journey list 从约 0.91M 明显下降。
- Scheduled Tasks admin 不再因为 logs fan-out / 全表 count 达到约 4.18M。

### Dashboard

- 常见 30d 页面 Origin MISS 尽量控制在：
  - 基础页面：< 50k rows
  - 重分析页面：< 100k–200k rows
- Warm cache hit：D1 reads ≈ 0。

### Writes

- 不因为性能优化恢复大量 `visits` 索引。
- visit writes/flush 不上升。
- 若完成 UPSERT guard，则 writes 明显下降。

### 可靠性

- 不改变 legacy API 统计口径。
- 不改变权限模型。
- 不静默截断历史。
- 不用 cache hit 掩盖 origin SQL 成本。
- 每个优化都能通过 Worker version 独立回滚。

---

# 20. 何时重新考虑 Foundation

只有出现以下情况之一，才重新讨论 Foundation：

1. 直接 SQL 优化后，Journey / Task 仍长期无法降到可接受成本。
2. 必须引入长期 projection / snapshot / backfill。
3. 多个新读模型需要同时维护 base + derived data。
4. schema migration 已经需要 bridge writer / reconciliation。
5. 发布频率和团队规模使手工 Worker version rollback 不再足够。
6. 需要真正的 shadow-read / dual-read / gradual rollout 平台。

在此之前：

> Foundation 是可选的未来工程能力，不是当前性能修复的前置条件。

---

## 一句话实施策略

> **先消除确定存在的相关子查询、重复扫描、无界读取和无变化写入；利用现有 Cache + Rollup + D1 Insights 验收；只有这些优化仍不足时，再引入新的索引、rollup、projection 或 Foundation。**

## 实施进度

### 已完成里程碑

- Journey visitor/session detail 与 list 已改为 set-based ranking/aggregation，移除逐行
  first/last、event count 相关子查询；保留旧字段、排序、分页和空值语义。
- Scheduled Tasks group 列表已先分页，再通过 `page_runs` 与 `page_log_counts` 统计当前页
  日志；不再在分页前对所有 group 做相关日志扫描。
- Events summary 与 analytics context cards 已合并同窗口重复扫描，使用单次 filtered
  source 查询和按 card type 的 Top-N 排名。
- Pages tabs、overview client dimensions 与 overview geo dimensions 已改为数据库侧
  `GROUP BY + ROW_NUMBER + LIMIT`，Worker 不再接收整段窗口的 raw visits；entry/exit
  通过同一 SQL 的 session ranking 计算。
- Technology browser version breakdown 已将 top-browser 与 version 聚合合并到单次
  filtered source 查询，保留 browser/version limit、unknown/other bucket 和空结果行为。
- Technology share trends（browser、client dimension、UTM 与 referrer）已将 top labels、
  series 与 bucket 聚合合并为一次 D1 查询，并显式 materialize 共享 filtered source，避免
  SQLite 将 CTE 展开为重复 visits 扫描。真实 SQLite fixture 覆盖跨 bucket 标签变更、Other、
  filters 和空 visitor；`EXPLAIN QUERY PLAN` 确认通过 `idx_visits_site_started_at` 的 visits
  索引入口仅一次。仍须以生产 Origin MISS 的 D1 Insights 验证实际 rows-read 下降。
- visits UPSERT 已增加 null-safe 差异 guard：完全相同的业务快照不再触发 `DO UPDATE`；
  late performance 与 identity 字段仍会更新。`updated_at` 仅在业务字段变化时推进，
  `ae_synced_at` 作为 archive 内部状态不再被 ingest flush 的 `NULL` 覆盖。真实 SQLite
  replay 覆盖重复 flush、迟到 performance 与 identity 更新；生产写入下降仍按 Phase 0 的
  writes/flush 指标验收。
- Notification tick、手动执行和预览现在使用 invocation-scoped cache：相同站点与窗口的
  overview/metric、previous window、cumulative metric、site metadata 和 last-seen 查询在
  同一 invocation 内复用；不同站点、窗口或过滤条件不会共享，拒绝的 Promise 不会污染后续
  查询。邮件投递在同一 invocation 内只读取一次系统邮件配置，不新增 KV/DO 或持久化状态。
- 上述改动已通过真实 SQLite Scheduled Tasks 测试、Journey/Events 回归测试和 TypeScript
  类型检查；Pages/dimensions 与 technology 回归测试、TypeScript 与 lint 亦已通过。
- Notification cache 已补充同窗口跨 metric 复用、站点/窗口隔离、报告复用、previous/
  cumulative/last-seen 复用、邮件配置单次读取和 rejected-entry 清理测试。当前完整检查为
  196 个测试文件、2709 个测试通过；Statements 95.94%、Branches 88.00%、Functions
  98.09%、Lines 97.39%。生产 Origin MISS 的实际下降仍需部署后按 Phase 0 指标验收。

### 后续阶段

Technology 其他 cross/trend 路径的重复窗口扫描、历史数据兼容证明后的 canonical
predicate、visit UPSERT 差异 guard、索引候选和 rollup
仍按本计划后续门槛推进；未有
`EXPLAIN QUERY PLAN` 与生产 Origin MISS 证据的改动不得提前扩大 schema。
