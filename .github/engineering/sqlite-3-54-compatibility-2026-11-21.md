# SQLite 3.54.x 兼容性待办（2026-11-21）

## 状态

GitHub Actions `Test` Job 暂时固定 **Node 24.17.0 / SQLite 3.53.0**，其他 Quality、Spec、Build Job 仍使用当前 Node 24。目的是使可验证、已通过的回归测试与覆盖率恢复为可信的 CI 门禁；**这不是宣称复杂 Filter-SQL 已适配 SQLite 3.54.1**。

## 原生 Linux 实测矩阵

| 平台 / Node / SQLite | 五个失败文件 | 全量测试 |
| --- | --- | --- |
| Windows / Node 24.8.0 / SQLite 3.50.4 | 122/122 通过 | `check:verify` 通过 |
| WSL Debian Linux / Node 24.8.0 / SQLite 3.50.4 | 122/122 通过 | 未单独执行 |
| WSL Debian Linux / Node 24.17.0 / SQLite 3.53.0 | 122/122 通过 | **473 文件 / 4,915 用例**，覆盖率 95.02% / 88.34% / 98.33% / 96.30% |
| WSL Debian Linux / Node 24.22.3 / SQLite 3.54.1 | 117/122，失败 5 项 | GitHub 两次提交出现相同的失败 |

失败文件/行为：

- `query-performance.test.ts`：共享 Performance 源的列/结果映射不满足断言。
- `query-technology.test.ts`：Referrer/Channel 趋势结果为空而非预期值。
- `analytics-filtered-session-views.test.ts`：共享 Session Overview 计划报 `VIEWs and/or subqueries nested too deep`。
- `analytics-page-session-lowering.test.ts`：多层 AND/OR/NOT Session 集合 SQL 的 `EXPLAIN QUERY PLAN` 报同样深度错误。
- `filter-sql-production.test.ts`：Performance Reader 的复杂作用域 SQL 同样在 SQLite 3.54.1 下报深度错误。

这些失败均曾出现在本次 CI 修复之前的 GitHub Commit 中。SQLite 3.54.1 的加严 CTE/VIEW 展开安全检查是上述深度错误的重要背景；两项空值/结果变更仍应使用原始生成 SQL 单独定位，不能未经证明就把它们当作同一个原因。

## 下一步解除版本固定的验收标准

1. 保存**不含用户值**的 SQL 生成器测试用例，分别在 SQLite 3.53/3.54 上运行，找出重复 WITH CTE/子查询展开次数、SQL 长度和 `EXPLAIN` 结构；减少重复展开，保证正式 SQL 对较新 SQLite 可准备和执行。
2. 对 Referrer/Channel Trend、Performance Summary 做真正的值对照，不以更改测试期望/跳过断言替代修复；新增两版本差异回归。
3. 在最新 Node 24 Linux 上重新跑全部 473 个文件、4,915 个用例和覆盖率，并在支持的测试实例上评估 Cloudflare D1 SQL 执行及查询计划。通过后将 `node-version` 恢复为 `24`，移除临时注释。
4. 不要将测试固定的 SQLite 版本理解成生产 D1 的版本证明；当前 Cloudflare D1 具体引擎需另行独立验证。

## 参考资料

- SQLite 3.54 视图/CTE 深度安全变化与相关缺陷背景：<https://sqlite.org/bugs/forum>。
- Node.js 24.18.0 包含 SQLite 3.53.1 更新：<https://nodejs.org/en/blog/release/v24.18.0>。
