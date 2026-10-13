# FarmGuard

FarmGuard 是面向养殖场异常排查的桌面工作台。它将死亡率、环境与报警、用药库存、防疫记录组织成固定调查流程，保留每一步的证据、规则版本和执行记录，并把需要核实的问题交给执行人员确认。

## 主要功能

- **调查工作台**：按养殖场、猪舍、批次和时间窗创建案件，查看调查进度、环境曲线、风险报告和人工复核状态。
- **固定 SOP 取证**：先检查死亡率门槛；触发异常后，完成环境、用药库存、防疫三个方向的核查。
- **证据追溯**：原始工具结果保存为不可变快照，报告中的证据编号可以定位到来源、时间、查询范围和原始数据。
- **人工确认**：负责人填写复核意见，确认报告或保留待核实状态；统计版本冲突会进入人工复核。
- **结构化记忆**：分开保存事实、决策、经验和待办；用 FTS5/BM25 检索，并在截取 Top K 前限制业务范围与规则版本。
- **上下文计划**：规则、案件定位、调查待办与证据卡按字符预算组装，必要时拆为单节点，最小上下文超限时停止请求。
- **模型复核**：可配置模型与案件 MCP 工具，在专属工作区核对报告、读取原始证据并生成解释。
- **桌面与 CLI**：Electron 桌面用于业务操作；CLI 用于批量回放、导出 Trace 和验证调查分支。

## 桌面启动

运行环境：Windows、Node.js 24 LTS 和 npm。应用使用 Node.js 内置 SQLite。

从项目外层目录双击 `启动FarmGuard.cmd`，或在 PowerShell 执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./Start-FarmGuard.ps1
```

启动脚本会检查依赖、构建应用、启动本地后端，再打开桌面窗口。默认业务页面为 `http://127.0.0.1:3111/farmguard`。

首次按页面提示创建本地管理员。模型设置可以稍后完成；固定 SOP 取证、证据查看、报告与人工确认可独立运行。

从当前 `app/` 目录也可启动：

```powershell
npm run farmguard:start
```

更新源代码后重新构建并启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ../Start-FarmGuard.ps1 -Rebuild
```

完整操作步骤见 [演示指南](../DEMO_GUIDE.md)。
业务 API、认证和执行流程见 [FarmGuard 接口说明](docs/FARMGUARD.md)。

## 五类演示样例

项目提供合成业务记录与演示规则：

| 样例             | 观察与处理                                            |
| ---------------- | ----------------------------------------------------- |
| 正常批次         | 死亡率未触发门槛，结束本轮异常死亡调查，保留统计证据  |
| 环境恶化未报警   | 环境曲线超阈值、报警记录为空，继续完成用药与防疫核查  |
| 用药与库存不一致 | 登记用药与库存出库数量不一致，报告定位到差异证据      |
| 防疫记录延迟     | 实际完成日期晚于计划日期，保留日期与记录证据          |
| 统计口径冲突     | 同一天出现 7 / 9 两份记录且无有效版本关系，交人工核实 |

默认范围为 `farm-demo-01 / barn-03 / batch-2026-10-A`，时间窗为 `2026-10-01—2026-10-07`。当前规则版本为 `FG-2026.10`。阈值和数据均用于演示调查逻辑，实际应用时由业务规则与数据接口提供。

## 执行链路

```text
桌面提交调查
  → 已认证业务 API 校验范围
  → SQLite 保存案件与任务，返回 taskId
  → deterministic_sop 执行取证
  → 保存证据快照、步骤状态与 Trace
  → 生成带引用的报告
  → SSE 推送进度，界面读取最新结果
  → 执行人员记录复核意见
```

业务接口为 `POST /api/farmguard/call`，请求使用 `{ action, payload }`。首次启动调查返回 `{ taskId, caseId, status }`，进度通过 `GET /api/farmguard/events` 推送。每个已登录用户的案件、报告和记忆使用独立数据库目录。

当前取证模式是 `deterministic_sop`：规则驱动的固定流程负责取数、核对与生成结构化报告。配置模型后，模型复核通过 MCP 读取当前案件和证据，复核结论、说明差异与待办。报告中保留已核查方向；环境风险与死亡异常同期出现时，继续保留死亡原因需要进一步核实的结论边界。

任务、证据和执行状态均持久化。服务重新启动时恢复待处理任务，已完成工具结果按冻结快照复用，避免将恢复进度变成重复取证。

## CLI 与回归验证

在 `app/` 中执行：

```powershell
npm run farmguard:test
npm run farmguard:replay -- --data-dir ../verification/core-replay
npm run farmguard:replay -- --scenario environment_no_alert --data-dir ../verification/core-replay
npm exec tsx -- src/farmguard/cli.ts trace <caseId> --data-dir ../verification/core-replay
```

回放结果包含每类样例的报告状态、工具调用数量、证据覆盖与引用检查。正常门槛分支调用一个统计工具，异常分支完成四类取证。

测试覆盖调查范围、正常分支、异常发现、报告引用、版本过滤、重复提交、人工确认、重启恢复、上下文溢出和 MCP 案件隔离，并通过真实 stdio 子进程验证协议连接。

## MCP 与模型复核

选中案件后点击 **Agent 工作区**，应用会准备当前案件的复核工作区、工具连接与复核草稿。在模型设置中配置 Provider，然后在会话中发送复核草稿。

工具服务提供：

| 工具                    | 用途                              |
| ----------------------- | --------------------------------- |
| `farmguard_case`        | 当前案件定位和任务进度            |
| `farmguard_rules`       | 当前案件适用规则与阈值            |
| `farmguard_evidence`    | 读取冻结证据快照                  |
| `farmguard_investigate` | 执行当前案件 SOP 并生成待确认报告 |
| `farmguard_report`      | 读取报告、风险与待核实事项        |
| `farmguard_memory`      | 检索范围和规则版本匹配的记忆      |
| `farmguard_context`     | 预览上下文预算与保留内容          |

服务启动命令为 `npm run farmguard:mcp`，编译入口是 `dist/farmguard/mcp.js`。独立接入时，通过 `FARMGUARD_DATA_DIR` 指向用户业务数据库目录、`FARMGUARD_CASE_ID` 指定已授权案件。服务全程绑定该案件，读取其他案件的证据时返回拒绝结果；人工确认保留在业务界面。

## 工程入口

| 路径                           | 职责                                                |
| ------------------------------ | --------------------------------------------------- |
| `src/farmguard/core/`          | 领域类型、合成样例、SQLite 服务、SOP 与 ContextPlan |
| `src/farmguard/routes.ts`      | 已认证业务 API、SSE 和模型复核工作区                |
| `src/farmguard/mcp.ts`         | 案件范围绑定的 stdio MCP 工具                       |
| `src/farmguard/cli.ts`         | 回放、初始化样例与 Trace 导出                       |
| `web/src/farmguard/`           | React + TypeScript 调查界面                         |
| `tests/farmguard-core.test.ts` | 核心工作流与协议回归测试                            |
| `electron/`                    | 桌面窗口、菜单与受限桥接                            |
| `../Start-FarmGuard.ps1`       | Windows 启动与构建入口                              |

技术栈：React、TypeScript、Electron、Node.js、Hono、SQLite、FTS5 和 MCP。

运行配置、数据库、会话、日志与模型凭据保存在本地运行目录；仓库提供源码、锁文件、合成样例与测试。

## License

[MIT License](LICENSE)。
