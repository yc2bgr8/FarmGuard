# FarmGuard 业务接口与执行流程

FarmGuard 的业务入口为 `/farmguard`，HTTP 路由由 `src/farmguard/routes.ts` 挂载在 `/api/farmguard`。领域类型与返回字段以 `src/farmguard/core/types.ts` 为准。

## HTTP 与认证

| 接口                        | 认证        | 用途                                          |
| --------------------------- | ----------- | --------------------------------------------- |
| `GET /api/farmguard/health` | 公开        | 返回 `{ "ok": true, "service": "FarmGuard" }` |
| `POST /api/farmguard/call`  | Cookie 会话 | 调用业务动作                                  |
| `GET /api/farmguard/events` | Cookie 会话 | SSE 推送当前用户的调查事件                    |

`call` 请求使用 JSON envelope：

```json
{
  "action": "getCase",
  "payload": { "caseId": "case_..." }
}
```

`action` 为 1—80 字符的字符串，`payload` 为可选对象。成功响应直接返回动作结果，不增加 `data` 包装层。请求格式、动作或业务参数错误返回 HTTP 400 与 `{ "error": "..." }`；当前用户数据库中不存在的案件返回 404。缺少或无效的 Cookie 会话返回 401，停用用户等权限错误返回 403。

认证复用应用登录会话，中间件将用户身份存入请求上下文。客户端通过同源 Cookie 请求接口和建立 EventSource，不通过业务 payload 指定用户 ID。登录、会话与权限接口见 [API 文档](API.md)和[权限矩阵](ACL-MATRIX.md)。

## call 动作

| action               | payload                                                                                          | 成功返回                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `bootstrap`          | 无                                                                                               | `{ cases, rules, scenarios, stats }`                         |
| `listCases`          | 无                                                                                               | `FarmCase[]`                                                 |
| `getCase`            | `{ caseId }`                                                                                     | `CaseDetail`：案件字段、tasks、evidence、trace、report       |
| `getRules`           | 无                                                                                               | `RulePack[]`，包含当前与历史规则                             |
| `seedDemoCases`      | 无                                                                                               | `FarmCase[]`；重复调用复用已有样例                           |
| `createCase`         | 可选 `{ title, farmId, barnId, batchId, startDate, endDate, scenario }`                          | 新建 `FarmCase`                                              |
| `startInvestigation` | `{ caseId }`                                                                                     | `{ taskId, caseId, status }`，status 为 queued 或 running    |
| `confirmReport`      | `{ caseId, decision, note }`                                                                     | 更新后的 `CaseDetail`                                        |
| `queryMemory`        | 可选 `{ query, farmId, batchId, startDate, endDate, ruleVersion, kind, historicalFacts, limit }` | `MemoryRecord[]`                                             |
| `getContextPlan`     | `{ caseId, budgetChars? }`                                                                       | `ContextPlan`，HTTP 默认字符预算 6000                        |
| `prepareAgentReview` | `{ caseId }`                                                                                     | `{ jid, folder, profileId?, mcpId?, prompt, contextAction }` |
| `exportTrace`        | `{ caseId }`                                                                                     | `{ case, evidence, trace, report }`                          |

### 案件创建与范围

`scenario` 支持 `normal`、`environment_no_alert`、`medication_mismatch`、`vaccination_late`、`ambiguous`。当前数据模式固定为 `synthetic`。

默认定位为 `farm-demo-01 / barn-03 / batch-2026-10-A`，默认时间窗为 `2026-10-01—2026-10-07`。日期必须有效、起始不晚于结束，时间窗最长 32 天；名称和定位字段最长 160 字符。规则按该时间窗的结束日期从有效 Rule Pack 中选择。

每次工具调用都使用案件固定的 `farmId / barnId / batchId / startDate / endDate`，结果和报告同时记录规则版本。

### 调查受理与状态

`startInvestigation` 先将任务持久化，再返回受理结果，固定 SOP 在后台执行。同一案件已有 queued/running 任务时，重复提交返回同一个 taskId。

```json
{
  "taskId": "task_...",
  "caseId": "case_...",
  "status": "queued"
}
```

任务状态为 `queued / running / completed / failed`。案件状态为 `draft / queued / running / awaiting_confirmation / confirmed / needs_review / failed`。任务 completed 表示调查报告已生成，人工确认由独立动作记录。

`confirmReport` 的 decision 为 `confirmed` 或 `needs_review`，note 必填，最长 4000 字符。确认人使用当前已认证用户的显示名或用户名，客户端传入 actor 不参与身份选择。调查仍在执行时不能确认旧报告；缺少有效版本关系的统计冲突报告只能进入进一步复核。重复确认返回已有结果，不重复创建确认记录。

## SSE 事件

`GET /events` 成功建立连接后发送 `{ "type": "connected" }`；之后业务事件位于默认 SSE data 字段，每约 15 秒发送一次具名 `heartbeat` 事件，data 为 `{}`。

业务事件统一形状：

```json
{
  "type": "task_progress",
  "caseId": "case_...",
  "taskId": "task_...",
  "payload": {
    "step": "environment",
    "status": "completed",
    "evidenceId": "evidence_..."
  },
  "timestamp": "2026-10-12T12:00:00.000Z"
}
```

type 包括 `case_created`、`task_queued`、`task_progress`、`task_complete`、`task_error`、`report_confirmed`。taskId 和 payload 按事件可选。监听集合按用户 ID 隔离，连接断开后注销；事件不提供历史游标重放，重新连接后通过 `getCase` 或 `bootstrap` 获取持久化状态。

## 数据隔离与恢复

后端按当前登录用户创建 FarmGuardService，业务数据库为：

```text
DATA_DIR/farmguard/users/{userId}/farmguard.sqlite
```

案件、任务、报告、记忆和证据都在该用户数据库中查询。其他用户的案件 ID 在当前数据库中不存在；SSE 只收到当前用户的事件。

SQLite 保存任务状态和步骤、不可变证据快照、Trace、报告与人工确认。恢复时将未完成任务重新排入待执行状态，并按 taskId 与工具名复用已冻结的结果，不重复调用完成过的工具。MCP 连接设置 `recoverTasks: false`，只读取或执行绑定案件，避免重置宿主机服务的运行中任务。

## SOP、证据与报告

固定取证执行模式为 `deterministic_sop`：

1. 调用 `mortality_stats`，记录死亡数、期初数量、死亡率与阈值。
2. 未超过门槛时结束本轮异常死亡 SOP，其他方向标为 skipped。
3. 超过门槛时，依次调用 `environment_series`、`medication_inventory`、`vaccination_records`。
4. 每次取证保存来源、范围、时间、规则版本、关键结果、原始数据及 SHA256 快照 hash，Trace 记录工具输入与证据编号。
5. 生成 findings、checkedDirections、evidenceIds、unresolvedQuestions、recommendedActions 组成的结构化报告，等待人工确认。

环境与报警、用药库存和防疫记录按照各自规则核查。查到环境异常后仍完成剩余必查方向。报告将同期环境风险与死亡原因的判断分开，保留缺失或冲突问题；模型复核继续使用同一证据引用。

## 结构化记忆与上下文

记忆种类为 `fact / decision / lesson / open_loop`。检索在 SQL WHERE 中限制养殖场、批次、重叠时间窗与适用规则版本，再按 FTS5/BM25 排序并限制 Top K。当前决策无匹配时返回空结果；`historicalFacts: true` 只召回 fact，保留时间和来源。

ContextPlan 返回 blocks、totalChars、budgetChars、trimmed、overflow、action、preservedEvidenceIds、executionMode 和 reason。规则、案件定位、待办与证据编号受到保护，原始时间序列外置为快照，卡片保留关键值。

- `action: ready`：当前计划在预算内。
- `action: split`：构造单节点计划，完成后由后续调用重新组装下一步。
- `action: manual_review`：最小上下文仍超预算，阻断模型复核请求。

字符预算负责内容组装，不代替模型 tokenizer。准备模型复核时固定使用 6000 字符预算。

## prepareAgentReview 与模型工作区

动作要求当前用户为 admin，因为创建 Host 执行工作区。系统先读取该用户数据库中的案件，生成 ContextPlan 与复核 prompt；最小上下文超限时返回 400。

首次准备该案件时，应用通过内部已认证接口完成三项配置：

1. 注册用户范围的 MCP server，命令为当前 Node.js 可执行文件与 `dist/farmguard/mcp.js`。通过 `FARMGUARD_DATA_DIR` 指向该用户的业务数据库目录，通过 `FARMGUARD_CASE_ID` 固定案件。
2. 创建 FarmGuard Agent Profile，写入身份、证据原则、调查步骤和工具使用 Prompt；选择 managed context，关闭额外 Skills，只选择该案件 MCP。
3. 创建绑定 Profile 的 Host workspace，持久化 jid、folder、profileId 与 mcpId 的案件映射。

映射位于 `DATA_DIR/farmguard/agent-links/{userId}/{caseId}.json`。再次准备时核对工作区归属，可复用已有工作区，同时重新生成当前 prompt。

前端将 prompt 保存为该会话的草稿并跳转 `/chat/{folder}`。用户发送后，已配置模型通过案件工具复核；prepare 本身不发起模型请求，也不确认报告。工具包含 case、rules、evidence、investigate、report、memory、context，读取其他案件证据被拒绝。

## 代码与验证入口

- `src/farmguard/routes.ts`：HTTP 与模型工作区配置。
- `src/farmguard/core/service.ts`：SOP、持久化、恢复、报告和记忆。
- `src/farmguard/core/context.ts`：上下文预算计划。
- `src/farmguard/mcp.ts`：案件范围 MCP server。
- `web/src/farmguard/api.ts`：前端 HTTP 与事件类型。
- `tests/farmguard-core.test.ts`：领域流程、恢复与真实 stdio MCP 回归。

最低 Node.js 版本为 24.0.0，当前实际验证环境为 Node.js 24 LTS。主应用与 Agent Runner 使用同一 Node.js 版本。

```powershell
npm run farmguard:test
npm run farmguard:replay
npm run typecheck
```
