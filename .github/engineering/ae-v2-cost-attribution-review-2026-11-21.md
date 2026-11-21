# AE Invocation Metrics v2 — 成本归因审计（2026-11-21）

## 目的及当前结论

本审计针对生产 `insightflare_invocation_metrics` 的 `double20=2` 记录。AE v2 已能够可靠地定位高开销路由、受控 SQL Query ID、Filter Shape、D1 Statement/部分 Rows Read、DO Fetch，以及 API/SQL Engine Wall；保持 **每个 Invocation 一条 AE 记录**、不记录原始 SQL、参数和敏感用户输入是正确方向。

**但 AE v2 目前是诊断用数据，而非准确的账单或 SaaS 单客户 COGS。** 它记录的 `double6/7` 有覆盖率缺口，`double1/9/12` 是 Wall 而不是 Worker CPU/DO billable GB-s，缺少 KV/R2 操作类别和受控的租户归因。应在现有 v2 和平台官方使用量之间建立可审计的成本模型，而不是贸然增加 AE 写入。

## 真实生产观测

来源：Cloudflare Analytics Engine SQL API，只读，2026-11-21，北京时间约 16:20–16:40，应用版本 `0.7.1+2bb6e6a0590d`。以下只代表采样观测，并非全站完整账单。

- 团队站点汇总 16 站点：修复前单次约 50 条 D1 / 378,390–1,904,206 行已观测读取；修复后常见 6 条 D1 / 14,776 行已观测读取。固定 7 天的 API 返回 6,419 浏览量且两版一致。**旧版与新版的 AE 样本并非严格配对，百分比只能用于热点判断。**
- 新版一次 6 条 SQL 的 Invocation：Rollup 状态、小时明细、趋势边界、团队活动时间及站点列表各 1 条，另有 1 条 `unknown_d1`。该 `unknown_d1` 的行读取、SQL Engine、Rows Written 和 Attempts 覆盖均为 `unavailable`；总 Rows Read 标志为 `partial`，故 14,776 行是下界，而非精确计费值。真实 D1 API Wall 仍可能完全观测。
- 新版约 500 条样本的路由分组检查显示，`do.alarm` 多数多语句调用的 Rows Read/Rows Written 为 `partial`，`do.ingest` 的部分单语句操作甚至为 `unavailable`；这可能与 `first()` 不返回元信息、事务/Batch 语句及 DO 路径采集有关。需通过对照平台官方 D1/DO 用量和查询执行器逐项验证原因，不可只凭推测自动补零。
- `page.other` 的 Invocation Wall 大量显示 `0ms`；Logger 使用 `Math.round()` 将毫秒时间取整，所以 **0 可能是小于 0.5ms 的有效观测值**，不是 CPU=0，也不应直接解读为“未执行”。

## 字段语义与可靠性要求

| 数据 | 物理字段/来源 | 使用方式与限制 |
| --- | --- | --- |
| 版本 | `double20`、`blob10` | 必须过滤 `double20=2`；按 Commit 比较，不能混算 v1。 |
| 采样权重 | `_sample_interval` | `SUM(_sample_interval)` 估算调用数，成本型计数可用 `SUM(metric * _sample_interval)` 估算；同时报告有效样本数、时间窗口和误差风险。 |
| D1 请求和行数 | `double4/6/7` | Statement 数可做热点排名；读写行数必须先解码 `double19` 覆盖率。`complete` 才能当完整单次数据，`partial` 是下界，`unavailable` 不等于 0。 |
| D1 Engine/API 等待 | `double8/9` | Engine 执行耗时与 D1 API 总等待分开；并发请求的 API Wall 可超过 Invocation Wall，不能作为 Worker CPU。 |
| DO Fetch | `double11/12` | 上游调用数与等待，不等于 DO 计费的独立请求数或对象活跃 GB-s；注意与 `do.ingest`/`do.alarm` 单独 Invocation 的去重口径。 |
| DO SQLite | `double13` 及 `blob19.resources.doSqlRowsWritten` | 必须检查各自的覆盖率；SQLite DO 的行读写与 D1 分开计费。 |
| KV/R2 | `blob19.resources.kvOps/r2Ops` | 目前只有总操作次数，不区分 KV 类型、R2 Class A/B、存储/转出，无法据此直接计费。 |
| Query/Filter | `blob14–17`、`blob19.queries` | 仅安全 Query ID、Variant 和 Shape；SQL 模板/Family/unknown 必须按不同归因可信度分析。明细最多 6 条且可能截断。 |
| 完整性 | `double19`、`blob19.coverage`、`blob19.truncation` | 整体指标覆盖率与查询归因覆盖率是两回事；不要因为 `rankingCoverage=complete` 就断言行数或账单完整。 |
| CPU、DO 活跃时长 | 暂无准确 AE 字段 | Worker CPU 与 DO billable duration 应从 Cloudflare Workers/DO 官方分析或账单获取，严禁用 Wall Sum 推算真实费用。 |

`double19` 的 v2 行读取覆盖率占 bits 10–11，写入为 bits 12–13，SQL Engine 为 bits 14–15，D1 API Wall 为 bits 18–19；各 2-bit 值 `0=unavailable, 1=partial, 2=complete`。以 `invocation-schema-v2.ts` 为唯一权威定义，改动前先考虑历史兼容。

## 分阶段改进计划

### P0：不新增写入，先建立准确的成本分析视图

1. 建立 `source / route / version / time_bucket / metric / coverage` 维度的只读 AE 查询模板。每一项同时展示 `sampled_rows`、`weighted_invocations`、`complete_observations`、`partial_observations`、下界及置信度；缺失值不可参与“零成本”平均数。
2. 建立 **对账层**：D1 行读写、DO requests/duration/SQLite rows、Worker requests/CPU、KV、R2、AE 点写入/SQL 读取，分别用 Cloudflare 官方 Usage、D1 Metrics / GraphQL / Dashboard 作为账单真值。AE 用于路由/SQL 分摊，不代替全局总额。特别审计 `first()`/Batch 的 D1 meta 丢失及 D1 `unknown_d1`。
3. 量化 `unattributed` 桶与差异：平台计费总量 - AE 有效样本加权估计；差异非零时禁止输出精确单客户成本。

### P1：低开销完善归因，不扩容单 Invocation AE 点数量

1. 补齐高频 `unknown_d1` 的安全静态 Query ID；优先 API 鉴权/站点查询、DO Flush、Alarm。保留不可信观测的 unknown，不能根据请求路径或 SQL 字符串伪造 SQL 模板 ID。
2. 针对 `D1 first()`/Batch 记录行数能力做独立性能和 API 语义评估；若改用可返回 `meta` 的执行方法，必须验证 SQL 执行次数、结果一致性及实际成本，不能为了日志完整而增加数据库往返。
3. 若要支持多租户 SaaS COGS，规划有限、稳定、不可逆的租户归因 ID 与授权查询路径；不在 AE 暴露明文站点/团队 ID、SQL、域名、过滤值或用户标识。按团队汇总/权限映射应有明确的数据保留与轮换协议。

### P2：独立补充官方计费维度

1. Worker CPU 时间与 Workers 请求数：官方 Cloudflare Workers metrics/GraphQL/Logs；`invocationWallMs` 不等于 CPU。
2. DO 对象活跃时长：从官方 DO 计费指标获取并考虑并发共享、WebSocket hibernation；不能按每次 `doFetchWallMs` 相加当作 GB-s。
3. KV/R2：必要时把读写/操作类别分成固定、低基数的计数器，优先复用已有调用记录；DO SQLite 行写与 D1 行写严格隔离。
4. 汇总各 AE 数据集的真实写入量：Invocation Metrics 单点写入之外，现有 REQUEST/TRAFFIC/EVENT Analytics Engine 数据集也有独立写入。

### P3：成本模型、价格与验收

- 以计费项 `usage_unit × price_rate` 加上全账户级包含额度和共享基础费用构建费用预测。价格与免费额度应是带版本号、币种、有效期的配置，不能写死进 AE 行数据。
- 以真实历史 7/30 天数据对照 Cloudflare Usage/Billing，分别报告产品级、功能级与租户级成本、未归因额和估计误差；在数据完整性满足预设阈值前仅展示“成本下界/估计区间”。
- 验收必须包括：相同时间范围/统计作用域下 Raw 与 Rollup 结果一致；优化后 Rows Read/SQL 次数趋势下降；AE 单 Invocation 仍只写一条、无敏感数据泄露、无 D1 读写放大。

## 官方资料（2026-11-21 核对）

- AE 定价与写入计费单位：<https://developers.cloudflare.com/analytics/analytics-engine/pricing/>。该文档仍声明截至其发布时间 **AE 使用量尚未实际收费**；应以当前实际账单再确认。
- D1 行读写/存储价格及计费口径：<https://developers.cloudflare.com/d1/platform/pricing/>。
- Workers 请求、CPU 与 Wall 分别计费：<https://developers.cloudflare.com/workers/platform/pricing/>。
- DO requests、活跃 duration 和 SQLite rows：<https://developers.cloudflare.com/durable-objects/platform/pricing/>。
- D1 按查询分析：<https://developers.cloudflare.com/d1/observability/find-expensive-queries/>。
