export type ScenarioId =
  | 'normal'
  | 'environment_no_alert'
  | 'medication_mismatch'
  | 'vaccination_late'
  | 'ambiguous';
export type CaseStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'needs_review'
  | 'failed';
export type MemoryKind = 'fact' | 'decision' | 'lesson' | 'open_loop';

export interface InvestigationScope {
  farmId: string;
  barnId: string;
  batchId: string;
  startDate: string;
  endDate: string;
}

export interface FarmCase extends InvestigationScope {
  id: string;
  title: string;
  scenario: ScenarioId;
  status: CaseStatus;
  currentStep: string;
  ruleVersion: string;
  createdAt: string;
  updatedAt: string;
  dataMode: 'synthetic';
}

export interface InvestigationStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'skipped';
  evidenceIds: string[];
}

export interface InvestigationTask {
  id: string;
  caseId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  currentStep: string;
  steps: InvestigationStep[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Evidence {
  id: string;
  caseId: string;
  taskId: string;
  toolName: string;
  scope: InvestigationScope;
  source: string;
  sourceTimestamp: string;
  ruleVersion: string;
  summary: string;
  data: Record<string, unknown>;
  snapshotHash: string;
  createdAt: string;
}

export interface TraceEvent {
  id: string;
  caseId: string;
  taskId: string | null;
  sequence: number;
  type: string;
  step: string;
  message: string;
  toolName: string | null;
  parameters: Record<string, unknown> | null;
  evidenceIds: string[];
  timestamp: string;
}

export interface ReportFinding {
  id: string;
  severity: 'info' | 'warning' | 'high';
  title: string;
  summary: string;
  evidenceIds: string[];
  ruleId: string;
}

export interface InvestigationReport {
  id: string;
  caseId: string;
  taskId: string;
  title: string;
  status: 'normal' | 'risk' | 'needs_review';
  summary: string;
  findings: ReportFinding[];
  checkedDirections: {
    direction: string;
    outcome: string;
    evidenceIds: string[];
  }[];
  evidenceIds: string[];
  unresolvedQuestions: string[];
  recommendedActions: string[];
  ruleVersion: string;
  generatedAt: string;
  confirmed: boolean;
  confirmation: {
    decision: 'confirmed' | 'needs_review';
    actor: string;
    note: string;
    timestamp: string;
  } | null;
  executionMode: 'deterministic_sop';
}

export interface CaseDetail extends FarmCase {
  tasks: InvestigationTask[];
  evidence: Evidence[];
  trace: TraceEvent[];
  report: InvestigationReport | null;
}

export interface RulePack {
  id: string;
  title: string;
  version: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  current: boolean;
  thresholds: {
    weeklyDeathRatePct: number;
    temperatureC: number;
    ammoniaPpm: number;
  };
  rules: { id: string; title: string; description: string }[];
  notice: string;
}

export interface MemoryRecord {
  id: string;
  caseId: string | null;
  kind: MemoryKind;
  farmId: string;
  batchId: string;
  startDate: string;
  endDate: string;
  ruleVersion: string;
  title: string;
  body: string;
  source: string;
  evidenceIds: string[];
  createdAt: string;
  score?: number;
  historical?: boolean;
}

export interface MemoryQuery {
  query: string;
  farmId?: string;
  batchId?: string;
  startDate?: string;
  endDate?: string;
  ruleVersion?: string;
  kind?: MemoryKind;
  historicalFacts?: boolean;
  limit?: number;
}

export interface FarmGuardEvent {
  type:
    | 'case_created'
    | 'task_queued'
    | 'task_progress'
    | 'task_complete'
    | 'task_error'
    | 'report_confirmed';
  caseId: string;
  taskId?: string;
  payload?: unknown;
  timestamp: string;
}

export interface FarmGuardOptions {
  dataDir: string;
  onEvent?: (event: FarmGuardEvent) => void;
  autoRunTasks?: boolean;
  recoverTasks?: boolean;
}

export interface CreateCaseInput extends Partial<InvestigationScope> {
  title?: string;
  scenario?: ScenarioId;
}
