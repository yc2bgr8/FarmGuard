import { RULE_PACKS } from './fixtures.js';
import type { CaseDetail, Evidence, MemoryRecord } from './types.js';

export interface ContextBlock {
  id: string;
  role: 'policy' | 'scope' | 'plan' | 'evidence' | 'memory' | 'history';
  priority: number;
  content: string;
  protected: boolean;
  sourceIds: string[];
}

export interface ContextPlan {
  blocks: ContextBlock[];
  totalChars: number;
  budgetChars: number;
  trimmed: string[];
  overflow: boolean;
  action: 'ready' | 'split' | 'manual_review';
  preservedEvidenceIds: string[];
  executionMode: 'whole_investigation' | 'single_node' | 'blocked';
  reason: string;
}

export interface ContextPlanOptions {
  budgetChars?: number;
  history?: { id: string; content: string; sourceIds?: string[] }[];
  memories?: MemoryRecord[];
}

function evidenceText(evidence: Evidence): string {
  return `证据 ${evidence.id}｜${evidence.toolName}｜${evidence.source}｜${evidence.sourceTimestamp}｜规则 ${evidence.ruleVersion}\n${evidence.summary}\n原始快照 SHA256 ${evidence.snapshotHash}；需要明细时按证据编号读取冻结结果。`;
}

/** Character budgeting is explicit; a plan is not a tokenizer or model-window guarantee. */
export function buildContextPlan(
  detail: CaseDetail,
  options: ContextPlanOptions = {},
): ContextPlan {
  const budgetChars = options.budgetChars ?? 10_000;
  if (!Number.isFinite(budgetChars) || budgetChars < 1)
    throw new Error('上下文字符预算必须大于 0。');
  const latestTask = detail.tasks[0];
  const currentReport =
    !latestTask || detail.report?.taskId === latestTask.id ? detail.report : null;
  const evidence = detail.evidence.filter(
    (item) => !latestTask || item.taskId === latestTask.id,
  );
  const evidenceIds = evidence.map((item) => item.id);
  const rule = RULE_PACKS.find((item) => item.version === detail.ruleVersion);
  if (!rule) throw new Error('当前规则版本不可用，禁止继续构造上下文。');
  const globalPolicy =
    '仅核对已授权案件的记录；固定养殖场、猪舍、批次、时间窗；不得修改记录或执行用药处置；结论必须引用证据；未知与冲突要明确交人工核实；正常防疫记录不构成排除所有疾病的证明；历史事实不替代本批次证据；报告须人工确认。';
  const core: ContextBlock[] = [
    {
      id: 'global_policy',
      role: 'policy',
      priority: 100,
      protected: true,
      sourceIds: [rule.version],
      content: globalPolicy,
    },
    {
      id: 'case_scope',
      role: 'scope',
      priority: 100,
      protected: true,
      sourceIds: [detail.id],
      content: `案件 ${detail.id}\n养殖场 ${detail.farmId}；猪舍 ${detail.barnId}；批次 ${detail.batchId}；时间窗 ${detail.startDate} 至 ${detail.endDate}；当前规则 ${detail.ruleVersion}。`,
    },
    {
      id: 'current_rules',
      role: 'policy',
      priority: 95,
      protected: true,
      sourceIds: [rule.version],
      content: `${rule.title} ${rule.version}\n${JSON.stringify(rule.thresholds)}\n${rule.rules.map((item) => `${item.id}：${item.description}`).join('\n')}`,
    },
    {
      id: 'investigation_plan',
      role: 'plan',
      priority: 100,
      protected: true,
      sourceIds: latestTask ? [latestTask.id] : [],
      content: latestTask
        ? `当前步骤 ${latestTask.currentStep}。\n${latestTask.steps.map((step) => `${step.label}：${step.status}；证据 ${step.evidenceIds.join(', ') || '无'}`).join('\n')}\n待核实：${currentReport?.unresolvedQuestions.join('；') || '尚未生成报告或无待核实项'}`
        : '待办：死亡率门槛检查；若超过阈值，再查环境与报警、用药与库存、防疫记录。',
    },
    ...evidence.map(
      (item): ContextBlock => ({
        id: item.id,
        role: 'evidence',
        priority: 90,
        protected: true,
        sourceIds: [item.id],
        content: evidenceText(item),
      }),
    ),
  ];
  const optional: ContextBlock[] = [
    ...(options.memories ?? [])
      .filter(
        (item) =>
          item.ruleVersion === detail.ruleVersion &&
          item.farmId === detail.farmId &&
          item.batchId === detail.batchId &&
          item.endDate >= detail.startDate &&
          item.startDate <= detail.endDate,
      )
      .map(
        (item): ContextBlock => ({
          id: item.id,
          role: 'memory',
          priority: 50,
          protected: false,
          sourceIds: item.evidenceIds,
          content: `${item.kind} 记忆 ${item.id}｜来源 ${item.source}｜规则 ${item.ruleVersion}\n${item.body}`,
        }),
      ),
    ...(options.history ?? []).map(
      (item): ContextBlock => ({
        id: item.id,
        role: 'history',
        priority: 10,
        protected: false,
        sourceIds: item.sourceIds ?? [],
        content: item.content,
      }),
    ),
  ];
  let blocks = [...core, ...optional];
  const length = () =>
    blocks.reduce((sum, block) => sum + block.content.length, 0);
  const trimmed: string[] = [];
  for (const block of [...optional].sort((a, b) => a.priority - b.priority)) {
    if (length() <= budgetChars) break;
    blocks = blocks.filter((item) => item.id !== block.id);
    trimmed.push(block.id);
  }
  if (length() <= budgetChars)
    return {
      blocks,
      totalChars: length(),
      budgetChars,
      trimmed,
      overflow: false,
      action: 'ready',
      preservedEvidenceIds: evidenceIds,
      executionMode: 'whole_investigation',
      reason:
        '原始数据已外置为不可变快照；关键数值、规则、定位、待办和引用在预算内。',
    };

  // Current-node context keeps the global constraints, scope, all evidence references and pending steps.
  const nextStep =
    latestTask?.steps.find(
      (step) => step.status === 'pending' || step.status === 'running',
    )?.id ?? 'report';
  const ruleByStep: Record<string, string> = {
    mortality: 'mortality_gate',
    environment: 'environment_alert',
    medication: 'medication_inventory',
    vaccination: 'vaccination_schedule',
    report: 'evidence_boundary',
  };
  const ruleId = ruleByStep[nextStep];
  const currentRule = rule.rules.find((item) => item.id === ruleId);
  const compact: ContextBlock[] = [
    core[0]!,
    core[1]!,
    {
      id: 'node_rules',
      role: 'policy',
      priority: 100,
      protected: true,
      sourceIds: [rule.version],
      content: `只完成当前节点 ${nextStep}；规则 ${rule.version}。${currentRule?.description ?? ''} 阈值 ${JSON.stringify(rule.thresholds)}。`,
    },
    {
      id: 'compact_plan',
      role: 'plan',
      priority: 100,
      protected: true,
      sourceIds: latestTask ? [latestTask.id] : [],
      content: `步骤 ${latestTask?.steps.map((step) => `${step.id}:${step.status}`).join('；') ?? 'mortality:pending'}。待核实 ${currentReport?.unresolvedQuestions.join('；') || '无'}。所有证据引用 ${evidenceIds.join(', ') || '无'}。`,
    },
    ...evidence.map(
      (item): ContextBlock => ({
        id: `compact_${item.id}`,
        role: 'evidence',
        priority: 90,
        protected: true,
        sourceIds: [item.id],
        content: `${item.id}：${item.summary}`,
      }),
    ),
  ];
  const totalChars = compact.reduce(
    (sum, block) => sum + block.content.length,
    0,
  );
  if (totalChars <= budgetChars)
    return {
      blocks: compact,
      totalChars,
      budgetChars,
      trimmed: [...trimmed, 'full_evidence_cards', 'non_current_node_rules'],
      overflow: false,
      action: 'split',
      preservedEvidenceIds: evidenceIds,
      executionMode: 'single_node',
      reason:
        '完整计划超预算，改为只执行一个节点；状态和原始证据持续保存在存储中，完成后重新组装下一节点。',
    };
  return {
    blocks: compact,
    totalChars,
    budgetChars,
    trimmed,
    overflow: true,
    action: 'manual_review',
    preservedEvidenceIds: evidenceIds,
    executionMode: 'blocked',
    reason:
      '最小节点上下文仍超字符预算；阻断模型请求，保持关键内容完整，需增加预算或交人工分段。',
  };
}
