import { resolve } from 'node:path';
import { FarmGuardService, SCENARIOS, type ScenarioId } from './core/index.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'replay';
const directoryIndex = args.indexOf('--data-dir');
const dataDir = resolve(
  directoryIndex >= 0
    ? (args[directoryIndex + 1] ?? 'data/farmguard-cli')
    : 'data/farmguard-cli',
);
const service = new FarmGuardService({ dataDir, autoRunTasks: false });

try {
  if (command === 'replay') {
    const scenarioIndex = args.indexOf('--scenario');
    const selected =
      scenarioIndex >= 0 ? (args[scenarioIndex + 1] as ScenarioId) : undefined;
    const scenarios = selected
      ? SCENARIOS.filter((scenario) => scenario.id === selected)
      : SCENARIOS;
    if (!scenarios.length)
      throw new Error(
        '未知样例。使用 --scenario environment_no_alert 等类型。',
      );
    const results = [];
    for (const scenario of scenarios) {
      const farmCase = service.createCase({ scenario: scenario.id });
      const accepted = service.startInvestigation(farmCase.id);
      await service.runTask(accepted.taskId);
      const detail = service.getCase(farmCase.id);
      const expectedEvidence = scenario.id === 'normal' ? 1 : 4;
      const evidenceIds = new Set(
        detail.evidence.map((evidence) => evidence.id),
      );
      const referencesValid =
        detail.report?.findings.every((finding) =>
          finding.evidenceIds.every((evidenceId) =>
            evidenceIds.has(evidenceId),
          ),
        ) ?? false;
      const passed =
        detail.tasks[0]?.status === 'completed' &&
        detail.evidence.length === expectedEvidence &&
        referencesValid;
      results.push({
        scenario: scenario.id,
        caseId: farmCase.id,
        taskId: accepted.taskId,
        status: detail.report?.status,
        toolCalls: detail.trace.filter((event) => event.type === 'tool_call')
          .length,
        evidenceCount: detail.evidence.length,
        expectedEvidence,
        referencesValid,
        passed,
        summary: detail.report?.summary,
      });
    }
    console.log(
      JSON.stringify(
        {
          product: 'FarmGuard',
          dataMode: 'synthetic',
          executionMode: 'deterministic_sop',
          results,
          passed: results.every((result) => result.passed),
        },
        null,
        2,
      ),
    );
    if (results.some((result) => !result.passed)) process.exitCode = 1;
  } else if (command === 'trace') {
    const caseId = args[1];
    if (!caseId) throw new Error('用法：trace <caseId> --data-dir <directory>');
    console.log(JSON.stringify(service.exportTrace(caseId), null, 2));
  } else if (command === 'seed') {
    console.log(JSON.stringify(service.seedDemoCases(), null, 2));
  } else {
    throw new Error(
      '命令：replay [--scenario <type>] | seed | trace <caseId>；可追加 --data-dir <directory>。',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  service.close();
}
