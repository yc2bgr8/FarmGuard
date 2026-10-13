import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { buildContextPlan, type ContextPlan } from './context.js';
import {
  CURRENT_RULE_VERSION,
  fixtureFor,
  RULE_PACKS,
  SCENARIOS,
} from './fixtures.js';
import type {
  CaseDetail,
  CreateCaseInput,
  Evidence,
  FarmCase,
  FarmGuardEvent,
  FarmGuardOptions,
  InvestigationReport,
  InvestigationScope,
  InvestigationTask,
  MemoryQuery,
  MemoryRecord,
  ReportFinding,
  RulePack,
  TraceEvent,
} from './types.js';

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const scopeOf = (item: InvestigationScope): InvestigationScope => ({
  farmId: item.farmId,
  barnId: item.barnId,
  batchId: item.batchId,
  startDate: item.startDate,
  endDate: item.endDate,
});
const steps = () => [
  {
    id: 'mortality',
    label: '死亡率统计',
    status: 'pending' as const,
    evidenceIds: [] as string[],
  },
  {
    id: 'environment',
    label: '环境与报警核对',
    status: 'pending' as const,
    evidenceIds: [] as string[],
  },
  {
    id: 'medication',
    label: '用药与库存核对',
    status: 'pending' as const,
    evidenceIds: [] as string[],
  },
  {
    id: 'vaccination',
    label: '防疫记录核验',
    status: 'pending' as const,
    evidenceIds: [] as string[],
  },
];

function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

function terms(text: string): string {
  const words =
    text.toLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? [];
  return [
    ...new Set(
      words.flatMap((word) =>
        /\p{Script=Han}/u.test(word)
          ? [
              word,
              ...Array.from(word),
              ...Array.from(
                { length: Math.max(0, word.length - 1) },
                (_, index) => word.slice(index, index + 2),
              ),
            ]
          : [word],
      ),
    ),
  ].join(' ');
}

export class FarmGuardService {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly onEvent?: FarmGuardOptions['onEvent'];
  private readonly autoRunTasks: boolean;
  private closed = false;

  constructor(options: FarmGuardOptions) {
    mkdirSync(options.dataDir, { recursive: true });
    this.databasePath = join(options.dataDir, 'farmguard.sqlite');
    this.db = new DatabaseSync(this.databasePath);
    this.onEvent = options.onEvent;
    this.autoRunTasks = options.autoRunTasks !== false;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS fg_cases (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fg_tasks (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES fg_cases(id), status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS fg_one_active_task ON fg_tasks(case_id) WHERE status IN ('queued', 'running');
      CREATE TABLE IF NOT EXISTS fg_evidence (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES fg_cases(id), task_id TEXT NOT NULL REFERENCES fg_tasks(id), tool_name TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(task_id, tool_name));
      CREATE TRIGGER IF NOT EXISTS fg_evidence_immutable BEFORE UPDATE ON fg_evidence BEGIN SELECT RAISE(ABORT, 'evidence snapshots are immutable'); END;
      CREATE TABLE IF NOT EXISTS fg_trace (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES fg_cases(id), sequence INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(case_id, sequence));
      CREATE TABLE IF NOT EXISTS fg_reports (case_id TEXT PRIMARY KEY REFERENCES fg_cases(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fg_memory (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, farm_id TEXT NOT NULL, batch_id TEXT NOT NULL,
        start_date TEXT NOT NULL, end_date TEXT NOT NULL, rule_version TEXT NOT NULL,
        title TEXT NOT NULL, text TEXT NOT NULL, search_terms TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS fg_memory_fts USING fts5(title, text, search_terms, content='fg_memory', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS fg_memory_insert AFTER INSERT ON fg_memory BEGIN
        INSERT INTO fg_memory_fts(rowid,title,text,search_terms) VALUES(new.rowid,new.title,new.text,new.search_terms);
      END;
    `);
    if (options.recoverTasks !== false) this.recoverTasks();
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private emit(
    type: FarmGuardEvent['type'],
    caseId: string,
    taskId?: string,
    payload?: unknown,
  ): void {
    if (this.closed) return;
    try {
      this.onEvent?.({ type, caseId, taskId, payload, timestamp: now() });
    } catch {
      /* UI disconnection cannot roll back a durable task. */
    }
  }

  private row<T>(sql: string, ...params: SQLInputValue[]): T | null {
    const found = this.db.prepare(sql).get(...params);
    return found ? (JSON.parse(String(found.body)) as T) : null;
  }

  private rows<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db
      .prepare(sql)
      .all(...params)
      .map((found) => JSON.parse(String(found.body)) as T);
  }

  private writeCase(farmCase: FarmCase): void {
    farmCase.updatedAt = now();
    const stored: FarmCase = {
      ...scopeOf(farmCase),
      id: farmCase.id,
      title: farmCase.title,
      scenario: farmCase.scenario,
      status: farmCase.status,
      currentStep: farmCase.currentStep,
      ruleVersion: farmCase.ruleVersion,
      createdAt: farmCase.createdAt,
      updatedAt: farmCase.updatedAt,
      dataMode: farmCase.dataMode,
    };
    this.db
      .prepare('UPDATE fg_cases SET body = ? WHERE id = ?')
      .run(JSON.stringify(stored), farmCase.id);
  }

  private writeTask(task: InvestigationTask): void {
    task.updatedAt = now();
    this.db
      .prepare('UPDATE fg_tasks SET status = ?, body = ? WHERE id = ?')
      .run(task.status, JSON.stringify(task), task.id);
  }

  private trace(
    caseId: string,
    taskId: string | null,
    type: string,
    step: string,
    message: string,
    extra: Partial<
      Pick<TraceEvent, 'toolName' | 'parameters' | 'evidenceIds'>
    > = {},
  ): TraceEvent {
    const last = this.db
      .prepare(
        'SELECT COALESCE(MAX(sequence),0) AS sequence FROM fg_trace WHERE case_id = ?',
      )
      .get(caseId);
    const event: TraceEvent = {
      id: id('trace'),
      caseId,
      taskId,
      sequence: Number(last?.sequence ?? 0) + 1,
      type,
      step,
      message,
      toolName: extra.toolName ?? null,
      parameters: extra.parameters ?? null,
      evidenceIds: extra.evidenceIds ?? [],
      timestamp: now(),
    };
    this.db
      .prepare('INSERT INTO fg_trace(id,case_id,sequence,body) VALUES(?,?,?,?)')
      .run(event.id, caseId, event.sequence, JSON.stringify(event));
    return event;
  }

  getRules(): RulePack[] {
    return copy(RULE_PACKS);
  }

  private ruleFor(date: string): RulePack {
    const rule = RULE_PACKS.find(
      (item) =>
        item.effectiveFrom <= date &&
        (!item.effectiveTo || date <= item.effectiveTo),
    );
    if (!rule)
      throw new Error(
        '该业务日期没有可用规则版本，请使用 2025 年以后的演示时间窗。',
      );
    return rule;
  }

  bootstrap(): {
    cases: FarmCase[];
    rules: RulePack[];
    scenarios: typeof SCENARIOS;
    stats: {
      totalCases: number;
      running: number;
      awaitingConfirmation: number;
      confirmed: number;
      memories: number;
    };
  } {
    const cases = this.listCases();
    const count = this.db
      .prepare('SELECT COUNT(*) AS count FROM fg_memory')
      .get();
    return {
      cases,
      rules: this.getRules(),
      scenarios: copy(SCENARIOS),
      stats: {
        totalCases: cases.length,
        running: cases.filter((item) =>
          ['queued', 'running'].includes(item.status),
        ).length,
        awaitingConfirmation: cases.filter(
          (item) =>
            item.status === 'awaiting_confirmation' ||
            item.status === 'needs_review',
        ).length,
        confirmed: cases.filter((item) => item.status === 'confirmed').length,
        memories: Number(count?.count ?? 0),
      },
    };
  }

  createCase(input: CreateCaseInput = {}): FarmCase {
    const scenario = input.scenario ?? 'environment_no_alert';
    if (!SCENARIOS.some((item) => item.id === scenario))
      throw new Error('未知合成样例类型。');
    const startDate = input.startDate || '2026-10-01';
    const endDate = input.endDate || '2026-10-07';
    if (
      !validDate(startDate) ||
      !validDate(endDate) ||
      startDate > endDate ||
      Date.parse(endDate) - Date.parse(startDate) > 31 * 86_400_000
    )
      throw new Error('时间窗必须有效、起始日期不晚于结束日期，且最长 32 天。');
    const ruleVersion = this.ruleFor(endDate).version;
    const timestamp = now();
    const farmCase: FarmCase = {
      id: id('case'),
      title:
        input.title?.trim() ||
        SCENARIOS.find((item) => item.id === scenario)!.title,
      scenario,
      farmId: input.farmId?.trim() || 'farm-demo-01',
      barnId: input.barnId?.trim() || 'barn-03',
      batchId: input.batchId?.trim() || 'batch-2026-10-A',
      startDate,
      endDate,
      status: 'draft',
      currentStep: 'draft',
      ruleVersion,
      createdAt: timestamp,
      updatedAt: timestamp,
      dataMode: 'synthetic',
    };
    for (const field of [
      farmCase.farmId,
      farmCase.barnId,
      farmCase.batchId,
      farmCase.title,
    ])
      if (field.length > 160)
        throw new Error('名称和定位字段最长 160 个字符。');
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO fg_cases(id,body) VALUES(?,?)')
        .run(farmCase.id, JSON.stringify(farmCase));
      this.trace(
        farmCase.id,
        null,
        'case_created',
        'draft',
        '已建立合成调查案件，定位与时间窗已固定。',
        { parameters: { ...scopeOf(farmCase), scenario } },
      );
    });
    this.emit('case_created', farmCase.id, undefined, farmCase);
    return farmCase;
  }

  seedDemoCases(): FarmCase[] {
    const existing = this.listCases();
    for (const scenario of SCENARIOS)
      if (
        !existing.some(
          (item) =>
            item.scenario === scenario.id && item.title === scenario.title,
        )
      )
        this.createCase({ scenario: scenario.id, title: scenario.title });
    if (
      !this.db
        .prepare('SELECT id FROM fg_memory WHERE id = ?')
        .get('seed-current-decision')
    ) {
      for (let n = 0; n < 6; n++)
        this.addMemory({
          id: `seed-old-decision-${n}`,
          caseId: null,
          kind: 'decision',
          farmId: 'farm-demo-01',
          batchId: 'batch-2026-10-A',
          startDate: '2026-10-01',
          endDate: '2026-10-07',
          ruleVersion: 'FG-2025.01',
          title: '用药 库存 用药核对历史处置',
          body: `用药 库存 用药 库存 历史旧规则处置 ${n}，不适用于当前规则。`,
          source: '合成历史样例',
          evidenceIds: [],
        });
      this.addMemory({
        id: 'seed-current-decision',
        caseId: null,
        kind: 'decision',
        farmId: 'farm-demo-01',
        batchId: 'batch-2026-10-A',
        startDate: '2026-10-01',
        endDate: '2026-10-07',
        ruleVersion: CURRENT_RULE_VERSION,
        title: '用药库存核对流程',
        body: '用药与库存逐条比对，差异必须保留证据引用并进入人工复核。',
        source: '合成演示规则',
        evidenceIds: [],
      });
      this.addMemory({
        id: 'seed-historical-fact',
        caseId: null,
        kind: 'fact',
        farmId: 'farm-demo-01',
        batchId: 'batch-2025-01',
        startDate: '2025-01-01',
        endDate: '2025-01-07',
        ruleVersion: 'FG-2025.01',
        title: '环境温度历史事实',
        body: '合成历史曲线曾出现环境温度异常；它是历史事实，不能替代当前批次证据。',
        source: '合成历史传感器快照',
        evidenceIds: [],
      });
    }
    return this.listCases();
  }

  listCases(): FarmCase[] {
    return this.rows<FarmCase>('SELECT body FROM fg_cases ORDER BY rowid DESC');
  }

  getCase(caseId: string): CaseDetail {
    const farmCase = this.row<FarmCase>(
      'SELECT body FROM fg_cases WHERE id = ?',
      caseId,
    );
    if (!farmCase) throw new Error('调查案件不存在。');
    return {
      ...farmCase,
      tasks: this.rows<InvestigationTask>(
        'SELECT body FROM fg_tasks WHERE case_id = ? ORDER BY rowid DESC',
        caseId,
      ),
      evidence: this.rows<Evidence>(
        'SELECT body FROM fg_evidence WHERE case_id = ? ORDER BY rowid',
        caseId,
      ),
      trace: this.rows<TraceEvent>(
        'SELECT body FROM fg_trace WHERE case_id = ? ORDER BY sequence',
        caseId,
      ),
      report: this.row<InvestigationReport>(
        'SELECT body FROM fg_reports WHERE case_id = ?',
        caseId,
      ),
    };
  }

  startInvestigation(caseId: string): {
    taskId: string;
    caseId: string;
    status: 'queued' | 'running';
  } {
    const farmCase = this.getCase(caseId);
    const active = this.row<InvestigationTask>(
      "SELECT body FROM fg_tasks WHERE case_id = ? AND status IN ('queued','running')",
      caseId,
    );
    if (active)
      return {
        taskId: active.id,
        caseId,
        status: active.status as 'queued' | 'running',
      };
    const timestamp = now();
    const task: InvestigationTask = {
      id: id('task'),
      caseId,
      status: 'queued',
      currentStep: 'queued',
      steps: steps(),
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO fg_tasks(id,case_id,status,body) VALUES(?,?,?,?)')
        .run(task.id, caseId, task.status, JSON.stringify(task));
      farmCase.status = 'queued';
      farmCase.currentStep = 'queued';
      this.writeCase(farmCase);
      this.trace(
        caseId,
        task.id,
        'task_queued',
        'queued',
        '任务已持久化受理，等待 SOP 调查。',
      );
    });
    this.emit('task_queued', caseId, task.id, { status: 'queued' });
    if (this.autoRunTasks) this.schedule(task.id);
    return { taskId: task.id, caseId, status: 'queued' };
  }

  private schedule(taskId: string): void {
    setImmediate(() => {
      if (!this.closed) void this.runTask(taskId);
    });
  }

  private recoverTasks(): void {
    const pending = this.rows<InvestigationTask>(
      "SELECT body FROM fg_tasks WHERE status IN ('queued','running')",
    );
    for (const task of pending) {
      const farmCase = this.row<FarmCase>(
        'SELECT body FROM fg_cases WHERE id = ?',
        task.caseId,
      )!;
      this.transaction(() => {
        task.status = 'queued';
        this.writeTask(task);
        farmCase.status = 'queued';
        farmCase.currentStep = 'queued';
        this.writeCase(farmCase);
        this.trace(
          task.caseId,
          task.id,
          'task_recovered',
          task.currentStep,
          '恢复持久化任务；已有证据快照复用，已完成取证不重复执行。',
        );
      });
      if (this.autoRunTasks) this.schedule(task.id);
    }
  }

  private async stepTool(
    farmCase: FarmCase,
    task: InvestigationTask,
    stepId: string,
    toolName: string,
    rules: RulePack,
  ): Promise<Evidence> {
    if (this.closed) throw new Error('service_closed');
    const step = task.steps.find((item) => item.id === stepId)!;
    task.currentStep = stepId;
    step.status = 'running';
    farmCase.currentStep = stepId;
    this.transaction(() => {
      this.writeTask(task);
      this.writeCase(farmCase);
    });
    this.emit('task_progress', farmCase.id, task.id, {
      step: stepId,
      status: 'running',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    if (this.closed) throw new Error('service_closed');
    let evidence = this.row<Evidence>(
      'SELECT body FROM fg_evidence WHERE task_id = ? AND tool_name = ?',
      task.id,
      toolName,
    );
    this.transaction(() => {
      if (evidence) {
        this.trace(
          farmCase.id,
          task.id,
          'evidence_reused',
          stepId,
          '恢复时复用冻结证据快照。',
          { toolName, evidenceIds: [evidence.id] },
        );
      } else {
        const scope = scopeOf(farmCase);
        this.trace(
          farmCase.id,
          task.id,
          'tool_call',
          stepId,
          `调用 ${toolName}，范围固定为当前养殖场、猪舍、批次和时间窗。`,
          { toolName, parameters: { ...scope, ruleVersion: rules.version } },
        );
        const result = fixtureFor(farmCase, toolName, rules);
        const timestamp = now();
        evidence = {
          id: id('evidence'),
          caseId: farmCase.id,
          taskId: task.id,
          toolName,
          scope,
          source: `合成样例数据 · ${toolName}`,
          sourceTimestamp: `${farmCase.endDate}T23:59:59+08:00`,
          ruleVersion: rules.version,
          summary: result.summary,
          data: result.data,
          snapshotHash: createHash('sha256')
            .update(JSON.stringify(result.data))
            .digest('hex'),
          createdAt: timestamp,
        };
        this.db
          .prepare(
            'INSERT INTO fg_evidence(id,case_id,task_id,tool_name,body) VALUES(?,?,?,?,?)',
          )
          .run(
            evidence.id,
            farmCase.id,
            task.id,
            toolName,
            JSON.stringify(evidence),
          );
        this.trace(
          farmCase.id,
          task.id,
          'tool_result',
          stepId,
          result.summary,
          { toolName, evidenceIds: [evidence.id] },
        );
      }
      step.status = 'completed';
      step.evidenceIds = [evidence!.id];
      this.writeTask(task);
    });
    this.emit('task_progress', farmCase.id, task.id, {
      step: stepId,
      status: 'completed',
      evidenceId: evidence!.id,
    });
    return evidence!;
  }

  /** Explicit deterministic SOP runtime. Real model review is a separate product action. */
  async runTask(taskId: string): Promise<void> {
    if (this.closed) return;
    const task = this.row<InvestigationTask>(
      'SELECT body FROM fg_tasks WHERE id = ?',
      taskId,
    );
    if (!task || task.status !== 'queued') return;
    const claim = this.db
      .prepare(
        "UPDATE fg_tasks SET status = 'running' WHERE id = ? AND status = 'queued'",
      )
      .run(taskId);
    if (Number(claim.changes) !== 1) return;
    const farmCase = this.row<FarmCase>(
      'SELECT body FROM fg_cases WHERE id = ?',
      task.caseId,
    )!;
    try {
      const rules = this.ruleFor(farmCase.endDate);
      task.status = 'running';
      farmCase.status = 'running';
      this.transaction(() => {
        this.writeTask(task);
        this.writeCase(farmCase);
        this.trace(
          farmCase.id,
          task.id,
          'task_started',
          'mortality',
          `按 ${rules.version} 执行固定调查流程，结论限定为记录风险。`,
        );
      });
      const mortality = await this.stepTool(
        farmCase,
        task,
        'mortality',
        'mortality_stats',
        rules,
      );
      const evidence: Evidence[] = [mortality];
      if (mortality.data.exceedsThreshold === true) {
        this.trace(
          farmCase.id,
          task.id,
          'decision',
          'mortality',
          '死亡率超过阈值，继续环境、用药库存、防疫三方向取证。',
          { evidenceIds: [mortality.id] },
        );
        evidence.push(
          await this.stepTool(
            farmCase,
            task,
            'environment',
            'environment_series',
            rules,
          ),
        );
        evidence.push(
          await this.stepTool(
            farmCase,
            task,
            'medication',
            'medication_inventory',
            rules,
          ),
        );
        evidence.push(
          await this.stepTool(
            farmCase,
            task,
            'vaccination',
            'vaccination_records',
            rules,
          ),
        );
      } else {
        for (const step of task.steps)
          if (step.status === 'pending') step.status = 'skipped';
        this.trace(
          farmCase.id,
          task.id,
          'decision',
          'mortality',
          '死亡率未超过门槛，停止本条异常死亡 SOP；这不代表完成所有养殖风险检查。',
          { evidenceIds: [mortality.id] },
        );
      }
      if (this.closed) return;
      const report = this.makeReport(farmCase, task, evidence, rules);
      this.transaction(() => {
        this.db
          .prepare(
            'INSERT INTO fg_reports(case_id,body) VALUES(?,?) ON CONFLICT(case_id) DO UPDATE SET body=excluded.body',
          )
          .run(farmCase.id, JSON.stringify(report));
        task.status = 'completed';
        task.currentStep = 'done';
        this.writeTask(task);
        farmCase.status =
          report.status === 'needs_review'
            ? 'needs_review'
            : 'awaiting_confirmation';
        farmCase.currentStep = 'done';
        this.writeCase(farmCase);
        this.trace(
          farmCase.id,
          task.id,
          'report_generated',
          'report',
          '报告已保存，等待人工确认；没有执行任何真实处置。',
          { evidenceIds: report.evidenceIds },
        );
        this.storeReportMemory(farmCase, report);
      });
      this.emit('task_complete', farmCase.id, task.id, {
        report,
        status: farmCase.status,
      });
    } catch (error) {
      if (this.closed) return;
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      farmCase.status = 'failed';
      this.transaction(() => {
        this.writeTask(task);
        this.writeCase(farmCase);
        this.trace(
          farmCase.id,
          task.id,
          'task_error',
          task.currentStep,
          task.error!,
        );
      });
      this.emit('task_error', farmCase.id, task.id, { error: task.error });
    }
  }

  private makeReport(
    farmCase: FarmCase,
    task: InvestigationTask,
    evidence: Evidence[],
    rules: RulePack,
  ): InvestigationReport {
    const mortality = evidence.find(
      (item) => item.toolName === 'mortality_stats',
    )!;
    const environment = evidence.find(
      (item) => item.toolName === 'environment_series',
    );
    const medication = evidence.find(
      (item) => item.toolName === 'medication_inventory',
    );
    const vaccination = evidence.find(
      (item) => item.toolName === 'vaccination_records',
    );
    const findings: ReportFinding[] = [];
    const unresolvedQuestions: string[] = [];
    const recommendedActions: string[] = [];
    const add = (
      title: string,
      summary: string,
      evidenceIds: string[],
      ruleId: string,
      severity: ReportFinding['severity'] = 'warning',
    ) =>
      findings.push({
        id: id('finding'),
        title,
        summary,
        evidenceIds,
        ruleId,
        severity,
      });
    if (mortality.data.exceedsThreshold === true) {
      add(
        '死亡率超过调查门槛',
        mortality.summary,
        [mortality.id],
        'mortality_gate',
        'high',
      );
      recommendedActions.push(
        '请负责人核实死亡登记与批次情况，并根据业务流程安排进一步调查。',
      );
      unresolvedQuestions.push(
        '死亡原因尚不能由这些记录单独确定，需要负责人或兽医进一步核实。',
      );
    } else {
      add(
        '未触发异常死亡调查门槛',
        `${mortality.summary}。本轮仅完成死亡率门槛检查。`,
        [mortality.id],
        'mortality_gate',
        'info',
      );
      recommendedActions.push(
        '继续按正常巡检安排监测；本报告不代表所有方向均无风险。',
      );
    }
    if (environment?.data.abnormal === true) {
      add(
        '环境超阈值且无报警记录',
        `${environment.summary}。与死亡率异常同期出现，但不能据此直接认定死亡原因。`,
        [mortality.id, environment.id],
        'environment_alert',
        'high',
      );
      recommendedActions.push(
        '人工检查风机、传感器与报警配置，核实合成环境异常对应的记录。',
      );
    }
    if (
      medication &&
      Array.isArray(medication.data.mismatches) &&
      medication.data.mismatches.length
    ) {
      add(
        '用药与库存登记不一致',
        medication.summary,
        [medication.id],
        'medication_inventory',
        'high',
      );
      recommendedActions.push(
        '人工复核用药登记与库存出库明细，补齐或纠正相关记录。',
      );
    }
    if (
      vaccination &&
      Array.isArray(vaccination.data.rows) &&
      vaccination.data.rows.some(
        (row: Record<string, unknown>) => row.status !== 'completed',
      )
    ) {
      add(
        '防疫完成日期偏离计划',
        vaccination.summary,
        [vaccination.id],
        'vaccination_schedule',
      );
      recommendedActions.push('人工核对防疫计划、实际执行时间与补录情况。');
    }
    const conflicts = Array.isArray(mortality.data.conflicts)
      ? mortality.data.conflicts
      : [];
    if (conflicts.length) {
      add(
        '死亡统计存在未解决版本冲突',
        '同一日期出现 7 / 9 两份记录，缺少补录明细与继承版本关系，保留差异，不能自动选数。',
        [mortality.id],
        'evidence_boundary',
        'high',
      );
      unresolvedQuestions.push(
        '请核实 7 / 9 两份死亡登记的来源、业务日期、生成时间与补录版本关系。',
      );
      recommendedActions.push('完成冲突核实前，不把任一冲突值认定为最终统计。');
    }
    const checkedDirections = evidence.map((item) => ({
      direction:
        {
          mortality_stats: '死亡率',
          environment_series: '环境与报警',
          medication_inventory: '用药与库存',
          vaccination_records: '防疫记录',
        }[item.toolName] ?? item.toolName,
      outcome: item.summary,
      evidenceIds: [item.id],
    }));
    const status = conflicts.length
      ? 'needs_review'
      : mortality.data.exceedsThreshold === true
        ? 'risk'
        : 'normal';
    const summary =
      status === 'normal'
        ? '本时间窗未触发异常死亡调查门槛；保留统计证据，其他方向未展开。'
        : status === 'needs_review'
          ? '发现异常死亡记录与数据冲突，需要人工核实，报告保留所有冲突和证据。'
          : `死亡率异常，已完成四方向证据核查，发现 ${findings.length} 项记录风险；死亡原因仍需人工确认。`;
    return {
      id: id('report'),
      caseId: farmCase.id,
      taskId: task.id,
      title: `${farmCase.title} · 调查报告`,
      status,
      summary,
      findings,
      checkedDirections,
      evidenceIds: evidence.map((item) => item.id),
      unresolvedQuestions,
      recommendedActions,
      ruleVersion: rules.version,
      generatedAt: now(),
      confirmed: false,
      confirmation: null,
      executionMode: 'deterministic_sop',
    };
  }

  private storeReportMemory(
    farmCase: FarmCase,
    report: InvestigationReport,
  ): void {
    const base = {
      caseId: farmCase.id,
      farmId: farmCase.farmId,
      batchId: farmCase.batchId,
      startDate: farmCase.startDate,
      endDate: farmCase.endDate,
      ruleVersion: report.ruleVersion,
      source: `调查报告 ${report.id}`,
      evidenceIds: report.evidenceIds,
    };
    this.addMemory({
      ...base,
      kind: 'fact',
      title: `${farmCase.title} · 已核查事实`,
      body: report.checkedDirections
        .map((item) => `${item.direction}：${item.outcome}`)
        .join('\n'),
    });
    this.addMemory({
      ...base,
      kind: 'decision',
      title: `${farmCase.title} · 调查决策`,
      body:
        report.status === 'normal'
          ? '死亡率门槛未触发，结束本轮异常死亡 SOP。'
          : '超过死亡率门槛，完成环境、用药库存、防疫核查；报告待人工确认。',
    });
    this.addMemory({
      ...base,
      kind: 'lesson',
      title: `${farmCase.title} · 复用原则`,
      body: '每次调查固定养殖场、猪舍、批次、时间窗；正常记录也是必查取证，不能因报告遗漏引用删除核查步骤。',
    });
    if (report.unresolvedQuestions.length)
      this.addMemory({
        ...base,
        kind: 'open_loop',
        title: `${farmCase.title} · 待核实事项`,
        body: report.unresolvedQuestions.join('\n'),
      });
  }

  addMemory(
    input: Omit<MemoryRecord, 'id' | 'createdAt' | 'score' | 'historical'> & {
      id?: string;
      createdAt?: string;
    },
  ): MemoryRecord {
    const record: MemoryRecord = {
      ...input,
      id: input.id ?? id('memory'),
      createdAt: input.createdAt ?? now(),
    };
    this.db
      .prepare(
        'INSERT OR IGNORE INTO fg_memory(id,kind,farm_id,batch_id,start_date,end_date,rule_version,title,text,search_terms,body) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        record.id,
        record.kind,
        record.farmId,
        record.batchId,
        record.startDate,
        record.endDate,
        record.ruleVersion,
        record.title,
        record.body,
        terms(`${record.title} ${record.body}`),
        JSON.stringify(record),
      );
    return record;
  }

  queryMemory(query: MemoryQuery): MemoryRecord[] {
    if (query.historicalFacts && query.kind && query.kind !== 'fact')
      throw new Error('历史召回只能读取 fact，不允许历史处置决策补位。');
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    const add = (column: string, value?: string) => {
      if (value) {
        conditions.push(`${column} = ?`);
        params.push(value);
      }
    };
    add('m.farm_id', query.farmId);
    add('m.batch_id', query.batchId);
    add('m.kind', query.historicalFacts ? 'fact' : query.kind);
    if (!query.historicalFacts)
      add('m.rule_version', query.ruleVersion ?? CURRENT_RULE_VERSION);
    if (query.startDate) {
      conditions.push('m.end_date >= ?');
      params.push(query.startDate);
    }
    if (query.endDate) {
      conditions.push('m.start_date <= ?');
      params.push(query.endDate);
    }
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 5)));
    const search = query.query.trim();
    if (search) {
      const searchTerms =
        search.match(/[a-z0-9_-]+|[\p{Script=Han}]+/giu) ?? [];
      if (!searchTerms.length) return [];
      const match = searchTerms
        .flatMap((word) =>
          /\p{Script=Han}/u.test(word) && word.length > 2
            ? Array.from({ length: word.length - 1 }, (_, index) =>
                word.slice(index, index + 2),
              )
            : [word],
        )
        .map((word) => `"${word.replaceAll('"', '""')}"`)
        .join(' OR ');
      // Metadata WHERE restrictions apply before ORDER/LIMIT; stale high-ranking rows cannot consume Top K.
      const rows = this.db
        .prepare(
          `SELECT m.body, bm25(fg_memory_fts, 2.0, 1.0, 0.5) AS score FROM fg_memory_fts JOIN fg_memory m ON m.rowid = fg_memory_fts.rowid WHERE fg_memory_fts MATCH ? ${conditions.length ? `AND ${conditions.join(' AND ')}` : ''} ORDER BY score ASC, m.rowid DESC LIMIT ?`,
        )
        .all(match, ...params, limit);
      return rows.map((row) => ({
        ...(JSON.parse(String(row.body)) as MemoryRecord),
        score: Number(row.score),
        historical: query.historicalFacts === true,
      }));
    }
    return this.rows<MemoryRecord>(
      `SELECT m.body FROM fg_memory m ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY m.rowid DESC LIMIT ?`,
      ...params,
      limit,
    ).map((record) => ({
      ...record,
      historical: query.historicalFacts === true,
    }));
  }

  confirmReport(
    caseId: string,
    input: {
      decision: 'confirmed' | 'needs_review';
      note: string;
      actor?: string;
    },
  ): CaseDetail {
    if (!['confirmed', 'needs_review'].includes(input.decision))
      throw new Error('未知人工确认决定。');
    if (!input.note?.trim()) throw new Error('人工确认必须填写核实意见。');
    if (input.note.length > 4000) throw new Error('核实意见最长 4000 字。');
    const farmCase = this.getCase(caseId);
    const report = farmCase.report;
    if (!report) throw new Error('调查完成并生成报告后才能确认。');
    if (
      farmCase.tasks.some(
        (task) => task.status === 'running' || task.status === 'queued',
      )
    )
      throw new Error('调查仍在执行，不能确认旧报告。');
    if (report.confirmation) return farmCase;
    if (input.decision === 'confirmed' && report.status === 'needs_review')
      throw new Error(
        '存在未解决的数据冲突，不能标记最终确认；请记录复核意见。',
      );
    report.confirmed = input.decision === 'confirmed';
    report.confirmation = {
      decision: input.decision,
      actor: input.actor?.trim() || '本地执行人员',
      note: input.note.trim(),
      timestamp: now(),
    };
    farmCase.status =
      input.decision === 'confirmed' ? 'confirmed' : 'needs_review';
    this.transaction(() => {
      this.db
        .prepare('UPDATE fg_reports SET body = ? WHERE case_id = ?')
        .run(JSON.stringify(report), caseId);
      this.writeCase(farmCase);
      this.trace(
        caseId,
        report.taskId,
        'human_confirmation',
        'confirmation',
        `${report.confirmation!.actor}：${input.note.trim()}`,
        {
          parameters: { decision: input.decision },
          evidenceIds: report.evidenceIds,
        },
      );
    });
    this.emit('report_confirmed', caseId, report.taskId, report.confirmation);
    return this.getCase(caseId);
  }

  exportTrace(caseId: string): {
    case: FarmCase;
    evidence: Evidence[];
    trace: TraceEvent[];
    report: InvestigationReport | null;
  } {
    const detail = this.getCase(caseId);
    const { tasks: _tasks, evidence, trace, report, ...farmCase } = detail;
    return { case: farmCase, evidence, trace, report };
  }

  getEvidence(evidenceId: string): Evidence {
    const evidence = this.row<Evidence>(
      'SELECT body FROM fg_evidence WHERE id = ?',
      evidenceId,
    );
    if (!evidence) throw new Error('证据不存在。');
    return evidence;
  }

  getContextPlan(caseId: string, budgetChars = 10_000): ContextPlan {
    const detail = this.getCase(caseId);
    const memories = this.queryMemory({
      query: '调查 用药 环境 防疫',
      farmId: detail.farmId,
      batchId: detail.batchId,
      startDate: detail.startDate,
      endDate: detail.endDate,
      ruleVersion: detail.ruleVersion,
      limit: 5,
    });
    return buildContextPlan(detail, { budgetChars, memories });
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
