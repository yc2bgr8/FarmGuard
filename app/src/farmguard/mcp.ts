import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FarmGuardService } from './core/index.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** A server is permanently bound to one already-authorized case and cannot approve reports. */
export function createFarmGuardMcpServer(
  service: FarmGuardService,
  caseId: string,
): McpServer {
  service.getCase(caseId);
  const server = new McpServer({
    name: 'farmguard-case-tools',
    version: '1.0.0',
  });
  server.registerTool(
    'farmguard_case',
    {
      description:
        '读取当前授权案件的养殖场、猪舍、批次、时间窗和 SOP 任务进度；不返回其他案件。',
      annotations: readOnly,
      inputSchema: {},
    },
    async () => {
      const {
        evidence: _evidence,
        trace: _trace,
        report: _report,
        ...farmCase
      } = service.getCase(caseId);
      return result(farmCase);
    },
  );
  server.registerTool(
    'farmguard_rules',
    {
      description:
        '读取当前案件适用规则、阈值和证据边界。所有阈值仅为合成演示规则。',
      annotations: readOnly,
      inputSchema: {},
    },
    async () => {
      const farmCase = service.getCase(caseId);
      return result(
        service
          .getRules()
          .filter((rules) => rules.version === farmCase.ruleVersion),
      );
    },
  );
  server.registerTool(
    'farmguard_evidence',
    {
      description:
        '按证据编号或工具名称读取当前案件的冻结原始证据；证据不属于当前案件时拒绝。',
      annotations: readOnly,
      inputSchema: {
        evidenceId: z.string().optional(),
        toolName: z
          .enum([
            'mortality_stats',
            'environment_series',
            'medication_inventory',
            'vaccination_records',
          ])
          .optional(),
      },
    },
    async ({ evidenceId, toolName }) => {
      if (evidenceId) {
        const evidence = service.getEvidence(evidenceId);
        if (evidence.caseId !== caseId)
          return {
            ...result({ error: '证据不属于当前授权案件。' }),
            isError: true,
          };
        return result(evidence);
      }
      const detail = service.getCase(caseId);
      const latestTask = detail.tasks[0];
      return result(
        detail.evidence.filter(
          (evidence) =>
            (!latestTask || evidence.taskId === latestTask.id) &&
            (!toolName || evidence.toolName === toolName),
        ),
      );
    },
  );
  server.registerTool(
    'farmguard_investigate',
    {
      description:
        '执行当前案件固定 SOP：死亡率门槛、环境与报警、用药库存、防疫核查。只生成待人工确认报告，不执行业务处置。已有报告时返回现有结果。',
      annotations: { ...readOnly, readOnlyHint: false },
      inputSchema: {},
    },
    async () => {
      const before = service.getCase(caseId);
      if (
        before.report &&
        !before.tasks.some((task) =>
          ['queued', 'running'].includes(task.status),
        )
      )
        return result({ status: before.status, report: before.report });
      const accepted = service.startInvestigation(caseId);
      await service.runTask(accepted.taskId);
      const detail = service.getCase(caseId);
      return result({
        taskId: accepted.taskId,
        status: detail.status,
        report: detail.report,
      });
    },
  );
  server.registerTool(
    'farmguard_report',
    {
      description:
        '读取当前案件报告、风险、已排查方向、证据编号和未解决问题；核验结束不代表确认完成。',
      annotations: readOnly,
      inputSchema: {},
    },
    async () => result(service.getCase(caseId).report),
  );
  server.registerTool(
    'farmguard_memory',
    {
      description:
        '查询当前案件定位与时间窗内的结构化记忆。先限制养殖场、批次、日期和规则版本，再按 FTS5/BM25 排序。历史模式只召回事实，不能用旧处置建议补位。',
      annotations: readOnly,
      inputSchema: {
        query: z.string().max(300),
        kind: z.enum(['fact', 'decision', 'lesson', 'open_loop']).optional(),
        historicalFacts: z.boolean().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ query, kind, historicalFacts, limit }) => {
      const detail = service.getCase(caseId);
      return result(
        service.queryMemory({
          query,
          kind,
          historicalFacts,
          limit,
          farmId: detail.farmId,
          batchId: detail.batchId,
          startDate: detail.startDate,
          endDate: detail.endDate,
          ruleVersion: detail.ruleVersion,
        }),
      );
    },
  );
  server.registerTool(
    'farmguard_context',
    {
      description:
        '预览本案件上下文预算计划：规则、定位、待办、证据卡和记忆；若 action=manual_review 则最小上下文超预算，应停止模型判断。字符预算不是 token 计量。',
      annotations: readOnly,
      inputSchema: {
        budgetChars: z.number().int().min(1).max(100_000).optional(),
      },
    },
    async ({ budgetChars }) =>
      result(service.getContextPlan(caseId, budgetChars)),
  );
  return server;
}

async function main(): Promise<void> {
  const caseId = process.env.FARMGUARD_CASE_ID;
  const directory = process.env.FARMGUARD_DATA_DIR;
  if (!caseId || !directory)
    throw new Error(
      '启动工具服务需要授权 FARMGUARD_CASE_ID 与 FARMGUARD_DATA_DIR。',
    );
  const service = new FarmGuardService({
    dataDir: resolve(directory),
    autoRunTasks: false,
    recoverTasks: false,
  });
  const server = createFarmGuardMcpServer(service, caseId);
  process.once('exit', () => service.close());
  await server.connect(new StdioServerTransport());
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
