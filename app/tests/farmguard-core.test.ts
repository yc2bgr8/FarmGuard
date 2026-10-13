import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFarmGuardMcpServer } from '../src/farmguard/mcp.js';
import {
  FarmGuardService,
  buildContextPlan,
  CURRENT_RULE_VERSION,
  type FarmGuardEvent,
  type ScenarioId,
} from '../src/farmguard/core/index.js';

const services: FarmGuardService[] = [];
const directories: string[] = [];
function setup(
  options: {
    autoRunTasks?: boolean;
    onEvent?: (event: FarmGuardEvent) => void;
  } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'farmguard-test-'));
  directories.push(dataDir);
  const service = new FarmGuardService({
    dataDir,
    autoRunTasks: false,
    ...options,
  });
  services.push(service);
  return { service, dataDir };
}
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('FarmGuard durable investigation workflow', () => {
  it('seeds five synthetic scenarios idempotently and preserves metadata', () => {
    const { service } = setup();
    expect(service.seedDemoCases()).toHaveLength(5);
    expect(service.seedDemoCases()).toHaveLength(5);
    expect(service.bootstrap().stats.memories).toBe(8);
    expect(
      service.listCases().every((item) => item.dataMode === 'synthetic'),
    ).toBe(true);
  });

  it('stops the death-rate SOP at the normal gate without pretending all directions were checked', async () => {
    const { service } = setup();
    const farmCase = service.createCase({ scenario: 'normal' });
    const task = service.startInvestigation(farmCase.id);
    await service.runTask(task.taskId);
    const detail = service.getCase(farmCase.id);
    expect(detail.report?.status).toBe('normal');
    expect(detail.evidence).toHaveLength(1);
    expect(
      detail.tasks[0]?.steps.filter((step) => step.status === 'skipped'),
    ).toHaveLength(3);
    expect(detail.report?.summary).toContain('其他方向未展开');
    expect(detail.status).toBe('awaiting_confirmation');
  });

  it.each([
    ['environment_no_alert', '环境超阈值且无报警记录'],
    ['medication_mismatch', '用药与库存登记不一致'],
    ['vaccination_late', '防疫完成日期偏离计划'],
  ] as [ScenarioId, string][])(
    'finishes all mandatory evidence for %s and finds the corresponding risk',
    async (scenario, expectedFinding) => {
      const { service } = setup();
      const farmCase = service.createCase({
        scenario,
        farmId: 'farm-isolated',
        barnId: 'barn-A',
        batchId: 'batch-Z',
      });
      const task = service.startInvestigation(farmCase.id);
      await service.runTask(task.taskId);
      const detail = service.getCase(farmCase.id);
      expect(detail.evidence).toHaveLength(4);
      expect(detail.report?.checkedDirections).toHaveLength(4);
      expect(
        detail.report?.findings.some(
          (finding) => finding.title === expectedFinding,
        ),
      ).toBe(true);
      expect(detail.report?.unresolvedQuestions.join(' ')).toContain(
        '死亡原因尚不能',
      );
      for (const evidence of detail.evidence)
        expect(evidence.scope).toEqual({
          farmId: 'farm-isolated',
          barnId: 'barn-A',
          batchId: 'batch-Z',
          startDate: '2026-10-01',
          endDate: '2026-10-07',
        });
      const evidenceIds = new Set(
        detail.evidence.map((evidence) => evidence.id),
      );
      for (const finding of detail.report!.findings)
        for (const evidenceId of finding.evidenceIds)
          expect(evidenceIds.has(evidenceId)).toBe(true);
      for (const event of detail.trace.filter(
        (event) => event.type === 'tool_call',
      ))
        expect(event.parameters?.batchId).toBe('batch-Z');
      expect(detail.trace.map((event) => event.sequence)).toEqual(
        detail.trace.map((_, index) => index + 1),
      );
    },
  );

  it('retains an unresolved 7/9 conflict, requires review and rejects final confirmation', async () => {
    const { service } = setup();
    const farmCase = service.createCase({ scenario: 'ambiguous' });
    const task = service.startInvestigation(farmCase.id);
    await service.runTask(task.taskId);
    const detail = service.getCase(farmCase.id);
    expect(detail.report?.status).toBe('needs_review');
    expect(detail.report?.unresolvedQuestions.join(' ')).toContain('7 / 9');
    expect(() =>
      service.confirmReport(farmCase.id, {
        decision: 'confirmed',
        note: '直接通过',
      }),
    ).toThrow('未解决');
    expect(
      service.confirmReport(farmCase.id, {
        decision: 'needs_review',
        note: '已交给登记人员核实版本关系',
      }).status,
    ).toBe('needs_review');
  });

  it('returns the same active task on repeated submission and records one human confirmation', async () => {
    const { service } = setup();
    const farmCase = service.createCase({ scenario: 'environment_no_alert' });
    const first = service.startInvestigation(farmCase.id);
    expect(service.startInvestigation(farmCase.id).taskId).toBe(first.taskId);
    expect(() =>
      service.confirmReport(farmCase.id, {
        decision: 'confirmed',
        note: '核实',
      }),
    ).toThrow('调查完成');
    await service.runTask(first.taskId);
    service.confirmReport(farmCase.id, {
      decision: 'confirmed',
      note: '已核实数据，后续处置由负责人判断',
      actor: '测试执行人员',
    });
    const final = service.confirmReport(farmCase.id, {
      decision: 'confirmed',
      note: '重复确认',
    });
    expect(final.status).toBe('confirmed');
    expect(
      final.trace.filter((event) => event.type === 'human_confirmation'),
    ).toHaveLength(1);
    expect(final.report?.confirmation?.note).toContain('已核实数据');
  });

  it('filters old rules and other farms BEFORE top K, while historical facts have a separate path', () => {
    const { service } = setup();
    service.seedDemoCases();
    const candidates = service.queryMemory({
      query: '用药 库存',
      farmId: 'farm-demo-01',
      batchId: 'batch-2026-10-A',
      ruleVersion: CURRENT_RULE_VERSION,
      kind: 'decision',
      limit: 5,
    });
    expect(candidates.map((record) => record.id)).toEqual([
      'seed-current-decision',
    ]);
    expect(
      service.queryMemory({
        query: '用药',
        farmId: 'other-farm',
        ruleVersion: CURRENT_RULE_VERSION,
      }),
    ).toHaveLength(0);
    expect(
      service.queryMemory({
        query: '用药',
        ruleVersion: 'FG-NONEXISTENT',
        kind: 'decision',
      }),
    ).toHaveLength(0);
    expect(
      service
        .queryMemory({ query: '环境', historicalFacts: true })
        .map((record) => record.id),
    ).toContain('seed-historical-fact');
    expect(() =>
      service.queryMemory({
        query: '用药',
        historicalFacts: true,
        kind: 'decision',
      }),
    ).toThrow('只能读取 fact');
  });

  it('persists a paused run and resumes with the same raw evidence snapshot without repeating a completed tool', async () => {
    let pauseAtMortality = true;
    let service: FarmGuardService;
    const setupResult = setup({
      onEvent: (event) => {
        const payload = event.payload as
          | { step?: string; status?: string }
          | undefined;
        if (
          pauseAtMortality &&
          event.type === 'task_progress' &&
          payload?.step === 'mortality' &&
          payload.status === 'completed'
        )
          service.close();
      },
    });
    service = setupResult.service;
    const farmCase = service.createCase({ scenario: 'environment_no_alert' });
    const task = service.startInvestigation(farmCase.id);
    await service.runTask(task.taskId);
    pauseAtMortality = false;
    const recovered = new FarmGuardService({
      dataDir: setupResult.dataDir,
      autoRunTasks: false,
    });
    services.push(recovered);
    const frozen = recovered.getCase(farmCase.id).evidence[0]!;
    await recovered.runTask(task.taskId);
    const detail = recovered.getCase(farmCase.id);
    expect(detail.report?.status).toBe('risk');
    expect(detail.evidence).toHaveLength(4);
    expect(detail.evidence[0]?.snapshotHash).toBe(frozen.snapshotHash);
    expect(detail.evidence[0]?.id).toBe(frozen.id);
    expect(
      detail.trace.filter(
        (event) =>
          event.type === 'tool_call' && event.toolName === 'mortality_stats',
      ),
    ).toHaveLength(1);
    expect(detail.trace.some((event) => event.type === 'task_recovered')).toBe(
      true,
    );
    expect(detail.trace.some((event) => event.type === 'evidence_reused')).toBe(
      true,
    );
    const reopened = new FarmGuardService({
      dataDir: setupResult.dataDir,
      autoRunTasks: false,
    });
    services.push(reopened);
    expect(reopened.getCase(farmCase.id).report?.id).toBe(detail.report?.id);
  });

  it('validates date windows instead of silently changing scope', () => {
    const { service } = setup();
    expect(() => service.createCase({ startDate: '2026-02-30' })).toThrow(
      '时间窗',
    );
    expect(() =>
      service.createCase({ startDate: '2026-10-08', endDate: '2026-10-01' }),
    ).toThrow('时间窗');
    expect(() =>
      service.createCase({ startDate: '2026-01-01', endDate: '2026-04-01' }),
    ).toThrow('时间窗');
  });

  it('builds evidence cards retaining key values and drops optional history before protected context', async () => {
    const { service } = setup();
    const farmCase = service.createCase({ scenario: 'environment_no_alert' });
    const accepted = service.startInvestigation(farmCase.id);
    await service.runTask(accepted.taskId);
    const detail = service.getCase(farmCase.id);
    const plan = buildContextPlan(detail, {
      budgetChars: 10_000,
      history: [{ id: 'old-chat', content: '过程描述 '.repeat(10_000) }],
    });
    expect(plan.action).toBe('ready');
    expect(plan.trimmed).toContain('old-chat');
    expect(plan.totalChars).toBeLessThanOrEqual(plan.budgetChars);
    expect(
      plan.blocks.find((block) => block.id === 'case_scope')?.content,
    ).toContain(detail.batchId);
    expect(plan.blocks.map((block) => block.content).join('\n')).toContain(
      '2.4%',
    );
    expect(plan.preservedEvidenceIds).toEqual(
      detail.evidence.map((evidence) => evidence.id),
    );
    expect(plan.blocks.map((block) => block.content).join('\n')).not.toContain(
      'timeseries',
    );
  });

  it('splits overlarge protected context into a single-node plan, or explicitly blocks when even minimum cannot fit', async () => {
    const { service } = setup();
    const farmCase = service.createCase({ scenario: 'environment_no_alert' });
    const accepted = service.startInvestigation(farmCase.id);
    await service.runTask(accepted.taskId);
    const detail = service.getCase(farmCase.id);
    const full = buildContextPlan(detail);
    const split = buildContextPlan(detail, {
      budgetChars: full.totalChars - 1,
    });
    expect(split.action).toBe('split');
    expect(split.executionMode).toBe('single_node');
    expect(split.totalChars).toBeLessThanOrEqual(split.budgetChars);
    expect(split.preservedEvidenceIds).toEqual(full.preservedEvidenceIds);
    const blocked = service.getContextPlan(farmCase.id, 50);
    expect(blocked.action).toBe('manual_review');
    expect(blocked.overflow).toBe(true);
    expect(blocked.executionMode).toBe('blocked');
    expect(blocked.totalChars).toBeGreaterThan(blocked.budgetChars);
    expect(
      blocked.blocks.find((block) => block.id === 'global_policy')?.content,
    ).toContain('人工');
  });

  it('does not reset another live runtime when opened as a non-owning MCP reader', async () => {
    const { service, dataDir } = setup();
    const farmCase = service.createCase({ scenario: 'environment_no_alert' });
    const accepted = service.startInvestigation(farmCase.id);
    const reader = new FarmGuardService({
      dataDir,
      autoRunTasks: false,
      recoverTasks: false,
    });
    services.push(reader);
    expect(
      reader
        .getCase(farmCase.id)
        .trace.some((event) => event.type === 'task_recovered'),
    ).toBe(false);
    await service.runTask(accepted.taskId);
    expect(reader.getCase(farmCase.id).report?.status).toBe('risk');
  });

  it('does not reuse a previous run report as the current run context', async () => {
    const { service } = setup();
    const farmCase = service.createCase({ scenario: 'ambiguous' });
    await service.runTask(service.startInvestigation(farmCase.id).taskId);
    service.startInvestigation(farmCase.id);
    const plan = buildContextPlan(service.getCase(farmCase.id));
    expect(plan.preservedEvidenceIds).toHaveLength(0);
    expect(plan.blocks.find((block) => block.id === 'investigation_plan')?.content).not.toContain('7 / 9');
  });

  it('starts the real MCP stdio process and initializes tools without corrupting protocol stdout', async () => {
    const { service, dataDir } = setup();
    const farmCase = service.createCase({ scenario: 'normal' });
    const client = new Client({ name: 'farmguard-stdio-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(process.cwd(), 'src', 'farmguard', 'mcp.ts')],
      env: { FARMGUARD_CASE_ID: farmCase.id, FARMGUARD_DATA_DIR: dataDir },
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(7);
      const response = await client.callTool({ name: 'farmguard_rules', arguments: {} });
      const content = response.content as { type: string; text: string }[];
      expect(JSON.parse(content[0]!.text)[0].version).toBe(farmCase.ruleVersion);
      expect(service.getCase(farmCase.id).trace.some((event) => event.type === 'task_recovered')).toBe(false);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 15_000);

  it('exposes seven real MCP tools pinned to one case and rejects cross-case evidence', async () => {
    const { service } = setup();
    service.seedDemoCases();
    const first = service.createCase({
      scenario: 'environment_no_alert',
      title: '授权案件',
    });
    const second = service.createCase({
      scenario: 'medication_mismatch',
      title: '另一案件',
    });
    await service.runTask(service.startInvestigation(second.id).taskId);
    const forbiddenEvidence = service.getCase(second.id).evidence[0]!;
    const server = createFarmGuardMcpServer(service, first.id);
    const client = new Client({
      name: 'farmguard-test-client',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(7);
      expect(
        tools.tools.some((tool) => /confirm|approve/.test(tool.name)),
      ).toBe(false);
      const caseResult = await client.callTool({
        name: 'farmguard_case',
        arguments: { caseId: second.id },
      });
      const caseContent = caseResult.content as {
        type: string;
        text: string;
      }[];
      expect(JSON.parse(caseContent[0]!.text).id).toBe(first.id);
      const forbidden = await client.callTool({
        name: 'farmguard_evidence',
        arguments: { evidenceId: forbiddenEvidence.id },
      });
      expect(forbidden.isError).toBe(true);
      const investigation = await client.callTool({
        name: 'farmguard_investigate',
        arguments: {},
      });
      const investigationContent = investigation.content as {
        type: string;
        text: string;
      }[];
      expect(JSON.parse(investigationContent[0]!.text).report.caseId).toBe(
        first.id,
      );
      expect(service.getCase(first.id).report?.confirmed).toBe(false);
      const memory = await client.callTool({
        name: 'farmguard_memory',
        arguments: {
          query: '用药 库存',
          kind: 'decision',
          farmId: 'other-farm',
        },
      });
      const memoryContent = memory.content as { type: string; text: string }[];
      const records = JSON.parse(memoryContent[0]!.text) as {
        farmId: string;
        ruleVersion: string;
      }[];
      expect(records.length).toBeGreaterThan(0);
      expect(
        records.every(
          (record) =>
            record.farmId === first.farmId &&
            record.ruleVersion === first.ruleVersion,
        ),
      ).toBe(true);
      const context = await client.callTool({
        name: 'farmguard_context',
        arguments: { budgetChars: 20 },
      });
      const contextContent = context.content as {
        type: string;
        text: string;
      }[];
      expect(JSON.parse(contextContent[0]!.text).action).toBe('manual_review');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
