import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Database,
  FileText,
  Layers3,
  LayoutDashboard,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sprout,
  X,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  CaseDetail,
  Evidence,
  FarmCase,
  MemoryKind,
  MemoryRecord,
  RulePack,
  ScenarioId,
} from '../../../src/farmguard/core/types';
import type { ContextPlan } from '../../../src/farmguard/core/context';
import { withBasePath } from '../utils/url';
import { describeError, farmguardCall } from './api';
import './FarmGuardApp.css';

type Section = 'investigations' | 'memory' | 'rules';
type DetailTab = 'overview' | 'report' | 'evidence' | 'trace' | 'context';
type Bootstrap = {
  cases: FarmCase[];
  rules: RulePack[];
  stats: Record<string, number>;
};

const SCENARIOS: { id: ScenarioId; label: string; description: string }[] = [
  {
    id: 'environment_no_alert',
    label: '环境异常 · 未触发报警',
    description: '死亡率异常后核查环境、用药与防疫证据。',
  },
  {
    id: 'medication_mismatch',
    label: '用药与库存差异',
    description: '定位用药登记与库存出库的数量差异。',
  },
  {
    id: 'vaccination_late',
    label: '防疫记录延迟',
    description: '核查计划与实际完成日期是否一致。',
  },
  {
    id: 'ambiguous',
    label: '统计记录冲突',
    description: '发现版本依据缺失的统计冲突，交人工复核。',
  },
  {
    id: 'normal',
    label: '正常批次',
    description: '未超过死亡率阈值时停止后续异常调查。',
  },
];
const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: '待调查', tone: 'neutral' },
  queued: { label: '排队中', tone: 'blue' },
  running: { label: '调查中', tone: 'blue' },
  awaiting_confirmation: { label: '待确认', tone: 'amber' },
  confirmed: { label: '已确认', tone: 'green' },
  needs_review: { label: '待复核', tone: 'amber' },
  failed: { label: '执行失败', tone: 'red' },
  risk: { label: '发现风险', tone: 'amber' },
  normal: { label: '未发现异常', tone: 'green' },
};
const TOOL_LABELS: Record<string, string> = {
  mortality_stats: '死亡率统计',
  environment_series: '环境与报警',
  medication_inventory: '用药与库存',
  vaccination_records: '防疫记录',
};
const STEP_LABELS: Record<string, string> = {
  mortality: '死亡率统计',
  environment: '环境与报警核对',
  medication: '用药与库存核对',
  vaccination: '防疫记录核验',
  report: '报告生成与校验',
  done: '调查已完成',
};
const KIND_LABELS: Record<MemoryKind, string> = {
  fact: '事实',
  decision: '决策',
  lesson: '经验',
  open_loop: '未完成事项',
};

function formatDate(value: string, time = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(
    'zh-CN',
    time
      ? {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'Asia/Shanghai',
        }
      : {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          timeZone: 'Asia/Shanghai',
        },
  ).format(date);
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object'),
      )
    : [];
}
function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}
function download(name: string, value: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
function Badge({ status }: { status: string }) {
  const item = STATUS[status] ?? { label: status, tone: 'neutral' };
  return (
    <span className={`fg-badge fg-badge-${item.tone}`}>
      <span />
      {item.label}
    </span>
  );
}
function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="fg-empty">
      <Layers3 size={28} />
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export default function FarmGuardApp({
  onOpenAssistant,
}: {
  onOpenAssistant?: (caseId?: string) => void;
}) {
  const [section, setSection] = useState<Section>('investigations');
  const [cases, setCases] = useState<FarmCase[]>([]);
  const [rules, setRules] = useState<RulePack[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [farmFilter, setFarmFilter] = useState('');
  const [barnFilter, setBarnFilter] = useState('');
  const [batchFilter, setBatchFilter] = useState('');
  const [timeStart, setTimeStart] = useState('');
  const [timeEnd, setTimeEnd] = useState('');
  const [newCase, setNewCase] = useState(false);
  const [viewEvidence, setViewEvidence] = useState<Evidence | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmationNote, setConfirmationNote] = useState('');
  const [confirmationDecision, setConfirmationDecision] = useState<
    'confirmed' | 'needs_review'
  >('confirmed');
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryKind, setMemoryKind] = useState('');
  const [memoryRule, setMemoryRule] = useState('');
  const [historicalFacts, setHistoricalFacts] = useState(false);
  const [memoryFarm, setMemoryFarm] = useState('');
  const [memoryBatch, setMemoryBatch] = useState('');
  const [memoryStart, setMemoryStart] = useState('');
  const [memoryEnd, setMemoryEnd] = useState('');
  const [memory, setMemory] = useState<MemoryRecord[]>([]);
  const [memorySearched, setMemorySearched] = useState(false);
  const [eventStreamConnected, setEventStreamConnected] = useState(false);
  const [contextBudget, setContextBudget] = useState(5_000);
  const [contextPlan, setContextPlan] = useState<ContextPlan | null>(null);
  const [create, setCreate] = useState({
    title: '',
    farmId: 'farm-demo-01',
    barnId: 'barn-03',
    batchId: 'batch-2026-10-A',
    startDate: '2026-10-01',
    endDate: '2026-10-07',
    scenario: 'environment_no_alert' as ScenarioId,
  });

  const refresh = useCallback(async (includeDetail = true) => {
    const data = await farmguardCall<Bootstrap>('bootstrap');
    setCases(data.cases);
    setRules(data.rules);
    const id =
      selectedRef.current ||
      data.cases.find((item) => item.scenario === 'environment_no_alert')?.id ||
      data.cases[0]?.id;
    if (id && !selectedRef.current) setSelectedId(id);
    if (includeDetail && id) {
      const next = await farmguardCall<CaseDetail>('getCase', { caseId: id });
      if (!selectedRef.current || selectedRef.current === id) setDetail(next);
    }
    return data;
  }, []);

  useEffect(() => {
    let mounted = true;
    refresh()
      .catch((err) => {
        if (mounted) setError(describeError(err));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setDetail(null);
    setContextPlan(null);
    farmguardCall<CaseDetail>('getCase', { caseId: selectedId })
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((err) => {
        if (active) setError(describeError(err));
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  useEffect(() => {
    const source = new EventSource(withBasePath('/api/farmguard/events'), {
      withCredentials: true,
    });
    source.onopen = () => setEventStreamConnected(true);
    source.onerror = () => setEventStreamConnected(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh().catch(() => undefined);
      }, 120);
    };
    source.onmessage = update;
    source.addEventListener('farmguard', update);
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const activeTask = cases.some(
    (item) => item.status === 'queued' || item.status === 'running',
  );
  useEffect(() => {
    if (!activeTask) return;
    const timer = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 1_800);
    return () => clearInterval(timer);
  }, [activeTask, refresh]);

  useEffect(() => {
    if (tab !== 'context' || !selectedId) return;
    let active = true;
    farmguardCall<ContextPlan>('getContextPlan', {
      caseId: selectedId,
      budgetChars: contextBudget,
    })
      .then((value) => {
        if (active) setContextPlan(value);
      })
      .catch((err) => {
        if (active) setError(describeError(err));
      });
    return () => {
      active = false;
    };
  }, [tab, selectedId, contextBudget, detail?.updatedAt]);

  const operate = async (name: string, action: () => Promise<void>) => {
    setPending(name);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending('');
    }
  };
  const currentRule = rules.find((rule) => rule.current);
  const latestTask = detail?.tasks[0];
  const busy = detail?.status === 'running' || detail?.status === 'queued';
  const visibleCases = cases.filter(
    (item) =>
      (!farmFilter || item.farmId === farmFilter) &&
      (!barnFilter || item.barnId === barnFilter) &&
      (!batchFilter || item.batchId === batchFilter) &&
      (!timeStart || item.endDate >= timeStart) &&
      (!timeEnd || item.startDate <= timeEnd) &&
      (!search ||
        `${item.title} ${item.batchId} ${item.barnId} ${item.id}`
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  const farmIds = [...new Set(cases.map((item) => item.farmId))];
  const barnIds = [
    ...new Set(
      cases
        .filter((item) => !farmFilter || item.farmId === farmFilter)
        .map((item) => item.barnId),
    ),
  ];
  const batchIds = [
    ...new Set(
      cases
        .filter((item) => !farmFilter || item.farmId === farmFilter)
        .map((item) => item.batchId),
    ),
  ];
  const currentEvidence =
    detail?.evidence.filter((item) => item.taskId === latestTask?.id) ?? [];
  const mortality = currentEvidence.find(
    (item) => item.toolName === 'mortality_stats',
  );
  const environment = currentEvidence.find(
    (item) => item.toolName === 'environment_series',
  );
  const medication = currentEvidence.find(
    (item) => item.toolName === 'medication_inventory',
  );
  const vaccination = currentEvidence.find(
    (item) => item.toolName === 'vaccination_records',
  );
  const openEvidence = (id: string) => {
    const item = detail?.evidence.find((evidence) => evidence.id === id);
    if (item) setViewEvidence(item);
  };
  const searchMemory = () =>
    operate('memory', async () => {
      const result = await farmguardCall<MemoryRecord[]>('queryMemory', {
        query: memoryQuery,
        ...(memoryFarm ? { farmId: memoryFarm } : {}),
        ...(memoryBatch ? { batchId: memoryBatch } : {}),
        ...(memoryStart ? { startDate: memoryStart } : {}),
        ...(memoryEnd ? { endDate: memoryEnd } : {}),
        ...(memoryKind ? { kind: memoryKind } : {}),
        ...(memoryRule
          ? { ruleVersion: memoryRule }
          : currentRule
            ? { ruleVersion: currentRule.version }
            : {}),
        historicalFacts,
        limit: 20,
      });
      setMemory(result);
      setMemorySearched(true);
    });

  return (
    <div className="fg-shell">
      <aside className="fg-sidebar">
        <div className="fg-brand">
          <div className="fg-brand-icon">
            <Sprout size={27} strokeWidth={1.8} />
          </div>
          <div>
            <strong>FarmGuard</strong>
            <span>养殖风险调查工作台</span>
          </div>
        </div>
        <div className="fg-workspace">
          <span className="fg-workspace-dot" />
          <div>
            <strong>养殖运营工作区</strong>
            <span>调查 · 取证 · 复核</span>
          </div>
          <ChevronRight size={15} />
        </div>
        <div className="fg-nav-caption">工作台</div>
        <nav className="fg-nav">
          <button
            className={section === 'investigations' ? 'fg-nav-active' : ''}
            onClick={() => setSection('investigations')}
          >
            <LayoutDashboard size={19} />
            <span>风险调查</span>
            <span className="fg-nav-count">{cases.length}</span>
          </button>
          <button
            className={section === 'memory' ? 'fg-nav-active' : ''}
            onClick={() => setSection('memory')}
          >
            <Database size={19} />
            <span>结构化记忆</span>
          </button>
          <button
            className={section === 'rules' ? 'fg-nav-active' : ''}
            onClick={() => setSection('rules')}
          >
            <ShieldCheck size={19} />
            <span>规则与版本</span>
          </button>
        </nav>
        <div className="fg-sidebar-card">
          <div className="fg-sidebar-card-icon">
            <ClipboardCheck size={19} />
          </div>
          <strong>每个判断，都能回到证据</strong>
          <p>围绕猪舍、批次与时间窗核查，保留工具结果和人工确认。</p>
          <span>
            <span className="fg-workspace-dot" />
            持久化调查记录
          </span>
        </div>
        <div className="fg-sidebar-bottom">
          {onOpenAssistant && (
            <button className="fg-assistant" onClick={() => onOpenAssistant?.(detail?.id)}>
              <Bot size={18} />
              Agent 工作区
              <ArrowRight size={16} />
            </button>
          )}
          <div className="fg-profile">
            <div>FG</div>
            <span>
              <strong>FarmGuard 运营台</strong>
              <small>合成样例数据环境</small>
            </span>
          </div>
        </div>
      </aside>
      <div className="fg-main">
        <header className="fg-topbar">
          <div>
            <span>工作区</span>
            <ChevronRight size={14} />
            <strong>
              {section === 'investigations'
                ? '风险调查'
                : section === 'memory'
                  ? '结构化记忆'
                  : '规则与版本'}
            </strong>
          </div>
          <div className="fg-topbar-right">
            <span>
              <CalendarDays size={15} />
              {formatDate(new Date().toISOString())}
            </span>
            <span className="fg-connection">
              <span
                style={{
                  background: eventStreamConnected ? '#5fa181' : '#bec9c1',
                }}
              />
              {eventStreamConnected ? '实时事件已连接' : '连接事件服务中'}
            </span>
          </div>
        </header>
        <main className="fg-content">
          {error && (
            <div className="fg-alert fg-alert-error" role="alert">
              <AlertTriangle size={17} />
              <span>{error}</span>
              <button aria-label="关闭错误提示" onClick={() => setError('')}>
                <X size={15} />
              </button>
            </div>
          )}
          {notice && (
            <div className="fg-alert fg-alert-success" role="status">
              <CheckCircle2 size={17} />
              <span>{notice}</span>
              <button aria-label="关闭提示" onClick={() => setNotice('')}>
                <X size={15} />
              </button>
            </div>
          )}
          {section === 'investigations' && (
            <>
              <div className="fg-page-heading">
                <div>
                  <span className="fg-eyebrow">
                    FARM OPERATIONS / INVESTIGATIONS
                  </span>
                  <h1>风险调查工作台</h1>
                  <p>从异常信号到证据报告，让每次排查有序可追溯。</p>
                </div>
                <div className="fg-heading-actions">
                  <button
                    className="fg-btn fg-btn-quiet"
                    disabled={Boolean(pending)}
                    onClick={() =>
                      void operate('refresh', async () => {
                        await refresh();
                      })
                    }
                  >
                    <RefreshCw
                      size={15}
                      className={pending === 'refresh' ? 'fg-spin' : ''}
                    />
                    刷新
                  </button>
                  <button
                    className="fg-btn fg-btn-primary"
                    onClick={() => setNewCase(true)}
                  >
                    <Plus size={17} />
                    新建调查
                  </button>
                </div>
              </div>
              <div className="fg-stats">
                <Stat
                  icon={<Layers3 size={20} />}
                  label="调查记录"
                  value={cases.length}
                  foot="完整保留批次与时间范围"
                />
                <Stat
                  icon={<Activity size={20} />}
                  label="正在调查"
                  value={
                    cases.filter((item) =>
                      ['queued', 'running'].includes(item.status),
                    ).length
                  }
                  foot="按 SOP 节点逐步取证"
                  tone="blue"
                />
                <Stat
                  icon={<ClipboardCheck size={20} />}
                  label="等待人工处理"
                  value={
                    cases.filter((item) =>
                      ['awaiting_confirmation', 'needs_review'].includes(
                        item.status,
                      ),
                    ).length
                  }
                  foot="复核结论与未解决问题"
                  tone="amber"
                />
                <Stat
                  icon={<CheckCircle2 size={20} />}
                  label="已确认报告"
                  value={
                    cases.filter((item) => item.status === 'confirmed').length
                  }
                  foot="确认记录持久保存"
                  tone="green"
                />
              </div>
              <div className="fg-filters">
                <label className="fg-search">
                  <Search size={17} />
                  <input
                    placeholder="搜索调查名称、猪舍或批次"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <select
                  aria-label="养殖场筛选"
                  value={farmFilter}
                  onChange={(event) => {
                    setFarmFilter(event.target.value);
                    setBarnFilter('');
                    setBatchFilter('');
                  }}
                >
                  <option value="">全部养殖场</option>
                  {farmIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="猪舍筛选"
                  value={barnFilter}
                  onChange={(event) => setBarnFilter(event.target.value)}
                >
                  <option value="">全部猪舍</option>
                  {barnIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="批次筛选"
                  value={batchFilter}
                  onChange={(event) => setBatchFilter(event.target.value)}
                >
                  <option value="">全部批次</option>
                  {batchIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="fg-filter-dates">
                <span>
                  <CalendarDays size={14} />
                  时间窗
                </span>
                <input
                  type="date"
                  aria-label="调查时间窗开始"
                  value={timeStart}
                  max={timeEnd || undefined}
                  onChange={(event) => setTimeStart(event.target.value)}
                />
                <span>至</span>
                <input
                  type="date"
                  aria-label="调查时间窗结束"
                  value={timeEnd}
                  min={timeStart || undefined}
                  onChange={(event) => setTimeEnd(event.target.value)}
                />
                {(timeStart || timeEnd) && (
                  <button
                    className="fg-text-button"
                    onClick={() => {
                      setTimeStart('');
                      setTimeEnd('');
                    }}
                  >
                    清除日期
                  </button>
                )}
                <small>匹配与当前时间窗重叠的调查</small>
              </div>
              <div className="fg-investigation-layout">
                <section className="fg-case-list fg-panel">
                  <div className="fg-panel-heading">
                    <h2>
                      调查队列 <span>{visibleCases.length}</span>
                    </h2>
                    <span>最近更新</span>
                  </div>
                  {loading ? (
                    <div className="fg-loading">
                      <Loader2 className="fg-spin" size={21} />
                      加载调查记录
                    </div>
                  ) : visibleCases.length ? (
                    visibleCases.map((item) => (
                      <button
                        key={item.id}
                        className={`fg-case-item ${selectedId === item.id ? 'fg-case-selected' : ''}`}
                        onClick={() => {
                          setSelectedId(item.id);
                          setTab('overview');
                        }}
                      >
                        <div className="fg-case-item-top">
                          <Badge status={item.status} />
                          <span>{formatDate(item.updatedAt, true)}</span>
                        </div>
                        <strong>{item.title}</strong>
                        <div className="fg-case-item-scope">
                          <span>{item.barnId}</span>
                          <span>{item.batchId}</span>
                        </div>
                        <div className="fg-case-item-bottom">
                          <span>
                            {item.startDate.slice(5)} — {item.endDate.slice(5)}
                          </span>
                          <ChevronRight size={16} />
                        </div>
                      </button>
                    ))
                  ) : (
                    <>
                      <Empty title="暂无调查记录">
                        新建一条调查，或载入预置样例。
                      </Empty>
                      <button
                        className="fg-btn fg-btn-outline fg-seed-btn"
                        disabled={Boolean(pending)}
                        onClick={() =>
                          void operate('seed', async () => {
                            await farmguardCall('seedDemoCases');
                            await refresh();
                            setNotice('样例已载入，可以启动调查。');
                          })
                        }
                      >
                        <Database size={15} />
                        载入调查样例
                      </button>
                    </>
                  )}
                </section>
                <section className="fg-case-detail fg-panel">
                  {!detail ? (
                    selectedId ? (
                      <div className="fg-loading">
                        <Loader2 className="fg-spin" size={22} />
                        读取调查详情
                      </div>
                    ) : (
                      <Empty title="选择或创建一条调查">
                        调查结果、原始证据和执行记录将在这里展示。
                      </Empty>
                    )
                  ) : (
                    <>
                      <div className="fg-detail-header">
                        <div>
                          <span className="fg-eyebrow">
                            INVESTIGATION / {detail.id.slice(-8).toUpperCase()}
                          </span>
                          <h2>{detail.title}</h2>
                          <div className="fg-detail-meta">
                            <span>{detail.farmId}</span>
                            <i /> <span>{detail.barnId}</span>
                            <i />
                            <span>{detail.batchId}</span>
                          </div>
                        </div>
                        <Badge status={detail.status} />
                      </div>
                      <div className="fg-scope-bar">
                        <span>
                          <CalendarDays size={15} />
                          {detail.startDate} — {detail.endDate}
                        </span>
                        <span>
                          <ShieldCheck size={15} />
                          {detail.ruleVersion}
                        </span>
                        <span>合成样例</span>
                      </div>
                      <div className="fg-detail-toolbar">
                        <div className="fg-detail-tabs">
                          {(
                            [
                              ['overview', '调查概览'],
                              ['report', '核查报告'],
                              ['evidence', '证据库'],
                              ['trace', '执行记录'],
                              ['context', '上下文'],
                            ] as const
                          ).map(([key, label]) => (
                            <button
                              className={tab === key ? 'fg-tab-active' : ''}
                              key={key}
                              onClick={() => setTab(key)}
                            >
                              {label}
                              {key === 'evidence' && (
                                <span>{detail.evidence.length}</span>
                              )}
                            </button>
                          ))}
                        </div>
                        <button
                          className="fg-btn fg-btn-primary fg-btn-small"
                          disabled={busy || Boolean(pending)}
                          onClick={() =>
                            void operate('run', async () => {
                              await farmguardCall('startInvestigation', {
                                caseId: detail.id,
                              });
                              await refresh();
                              setNotice('调查已受理，执行结果将按节点更新。');
                            })
                          }
                        >
                          {busy ? (
                            <Loader2 size={14} className="fg-spin" />
                          ) : (
                            <Activity size={14} />
                          )}
                          {busy
                            ? '正在调查'
                            : detail.report
                              ? '重新调查'
                              : '启动调查'}
                        </button>
                      </div>
                      <div className="fg-detail-body">
                        {latestTask?.error && (
                          <div className="fg-alert fg-alert-error">
                            <AlertTriangle size={16} />
                            <span>{latestTask.error}</span>
                          </div>
                        )}
                        {tab === 'overview' && (
                          <>
                            <div className="fg-section-title">
                              <div>
                                <h3>SOP 调查进度</h3>
                                <p>固定核查范围，记录完成步骤与证据。</p>
                              </div>
                              <span className="fg-small-tag">
                                {latestTask
                                  ? (STEP_LABELS[latestTask.currentStep] ??
                                    latestTask.currentStep)
                                  : '尚未启动'}
                              </span>
                            </div>
                            <div className="fg-sop">
                              {latestTask?.steps.length
                                ? latestTask.steps.map((step, index) => (
                                    <div
                                      key={step.id}
                                      className={`fg-sop-step fg-step-${step.status}`}
                                    >
                                      <div className="fg-step-icon">
                                        {step.status === 'completed' ? (
                                          <Check size={15} />
                                        ) : step.status === 'running' ? (
                                          <Loader2
                                            size={15}
                                            className="fg-spin"
                                          />
                                        ) : step.status === 'skipped' ? (
                                          <span>—</span>
                                        ) : (
                                          <span>{index + 1}</span>
                                        )}
                                      </div>
                                      <strong>{step.label}</strong>
                                      <span>
                                        {step.status === 'completed'
                                          ? '已完成'
                                          : step.status === 'running'
                                            ? '执行中'
                                            : step.status === 'skipped'
                                              ? '已跳过'
                                              : '待执行'}
                                      </span>
                                    </div>
                                  ))
                                : Object.entries(STEP_LABELS)
                                    .filter(([id]) => id !== 'done')
                                    .map(([id, label], index) => (
                                      <div
                                        key={id}
                                        className="fg-sop-step fg-step-pending"
                                      >
                                        <div className="fg-step-icon">
                                          {index + 1}
                                        </div>
                                        <strong>{label}</strong>
                                        <span>待执行</span>
                                      </div>
                                    ))}
                            </div>
                            {mortality ? (
                              <>
                                <div className="fg-mortality-summary">
                                  <div>
                                    <span>窗口死亡率</span>
                                    <strong>
                                      {num(mortality.data.deathRatePct).toFixed(
                                        2,
                                      )}
                                      <small>%</small>
                                    </strong>
                                    <span
                                      className={
                                        mortality.data.exceedsThreshold
                                          ? 'fg-text-amber'
                                          : 'fg-text-green'
                                      }
                                    >
                                      {mortality.data.exceedsThreshold
                                        ? '超过调查阈值'
                                        : '未超过调查阈值'}{' '}
                                      {String(mortality.data.thresholdPct)}%
                                    </span>
                                  </div>
                                  <div>
                                    <span>死亡数 / 期初头数</span>
                                    <strong>
                                      {String(mortality.data.totalDeaths)}
                                      <small>
                                        {' '}
                                        /{' '}
                                        {String(
                                          mortality.data.openingHeadcount,
                                        )}
                                      </small>
                                    </strong>
                                    <button
                                      className="fg-text-button"
                                      onClick={() => setViewEvidence(mortality)}
                                    >
                                      查看统计证据 <ArrowRight size={12} />
                                    </button>
                                  </div>
                                  <div className="fg-mortality-chart">
                                    <ResponsiveContainer
                                      width="100%"
                                      height={102}
                                    >
                                      <AreaChart
                                        data={rows(mortality.data.daily)}
                                        margin={{
                                          left: 0,
                                          right: 5,
                                          top: 8,
                                          bottom: 0,
                                        }}
                                      >
                                        <defs>
                                          <linearGradient
                                            id="fg-mortality-fill"
                                            x1="0"
                                            y1="0"
                                            x2="0"
                                            y2="1"
                                          >
                                            <stop
                                              offset="0%"
                                              stopColor="#29987c"
                                              stopOpacity={0.2}
                                            />
                                            <stop
                                              offset="100%"
                                              stopColor="#29987c"
                                              stopOpacity={0}
                                            />
                                          </linearGradient>
                                        </defs>
                                        <Tooltip
                                          contentStyle={{
                                            borderRadius: 8,
                                            fontSize: 12,
                                          }}
                                        />
                                        <XAxis
                                          dataKey="date"
                                          tickFormatter={(value: string) =>
                                            value.slice(5)
                                          }
                                          tick={{
                                            fontSize: 10,
                                            fill: '#7b8794',
                                          }}
                                          axisLine={false}
                                          tickLine={false}
                                        />
                                        <Area
                                          type="monotone"
                                          dataKey="deaths"
                                          name="死亡数量"
                                          stroke="#29987c"
                                          strokeWidth={2}
                                          fill="url(#fg-mortality-fill)"
                                        />
                                      </AreaChart>
                                    </ResponsiveContainer>
                                  </div>
                                </div>
                              </>
                            ) : (
                              <div className="fg-start-note">
                                <Activity size={20} />
                                <div>
                                  <strong>从死亡率统计开始</strong>
                                  <p>
                                    启动后先定位当前窗口的异常，达到阈值再继续环境、用药与防疫核查。
                                  </p>
                                </div>
                              </div>
                            )}
                            {environment && (
                              <div className="fg-environment-panel">
                                <div className="fg-section-title">
                                  <div>
                                    <h3>同一时间窗 · 环境变化</h3>
                                    <p>
                                      温度峰值{' '}
                                      {String(
                                        environment.data.peakTemperatureC,
                                      )}{' '}
                                      °C · 氨气峰值{' '}
                                      {String(environment.data.peakAmmoniaPpm)}{' '}
                                      ppm
                                    </p>
                                  </div>
                                  <button
                                    className="fg-text-button"
                                    onClick={() => setViewEvidence(environment)}
                                  >
                                    原始证据 <ArrowRight size={13} />
                                  </button>
                                </div>
                                <div className="fg-chart-legend">
                                  <span>
                                    <i style={{ background: '#2b9b7b' }} />
                                    温度 °C
                                  </span>
                                  <span>
                                    <i style={{ background: '#d49a50' }} />
                                    氨气 ppm
                                  </span>
                                  <span className="fg-chart-note">
                                    虚线：当前规则阈值
                                  </span>
                                </div>
                                <div className="fg-environment-chart">
                                  <ResponsiveContainer
                                    width="100%"
                                    height={195}
                                  >
                                    <LineChart
                                      data={rows(environment.data.timeseries)}
                                      margin={{
                                        top: 8,
                                        right: 10,
                                        left: -23,
                                        bottom: 0,
                                      }}
                                    >
                                      <CartesianGrid
                                        strokeDasharray="3 4"
                                        vertical={false}
                                        stroke="#e9eef0"
                                      />
                                      <XAxis
                                        dataKey="timestamp"
                                        tickFormatter={(value: string) =>
                                          value.slice(5, 10)
                                        }
                                        minTickGap={40}
                                        tick={{ fontSize: 10, fill: '#88949d' }}
                                        axisLine={false}
                                        tickLine={false}
                                      />
                                      <YAxis
                                        tick={{ fontSize: 10, fill: '#88949d' }}
                                        axisLine={false}
                                        tickLine={false}
                                      />
                                      <Tooltip
                                        labelFormatter={(value) =>
                                          formatDate(String(value), true)
                                        }
                                        contentStyle={{
                                          borderRadius: 8,
                                          fontSize: 12,
                                        }}
                                      />
                                      <ReferenceLine
                                        y={
                                          rules.find(
                                            (rule) =>
                                              rule.version ===
                                              environment.ruleVersion,
                                          )?.thresholds.temperatureC ??
                                          currentRule?.thresholds.temperatureC
                                        }
                                        stroke="#2b9b7b"
                                        strokeDasharray="4 4"
                                        opacity={0.45}
                                      />
                                      <ReferenceLine
                                        y={
                                          rules.find(
                                            (rule) =>
                                              rule.version ===
                                              environment.ruleVersion,
                                          )?.thresholds.ammoniaPpm ??
                                          currentRule?.thresholds.ammoniaPpm
                                        }
                                        stroke="#d49a50"
                                        strokeDasharray="4 4"
                                        opacity={0.5}
                                      />
                                      <Line
                                        dataKey="temperatureC"
                                        name="温度 °C"
                                        stroke="#2b9b7b"
                                        strokeWidth={2}
                                        dot={false}
                                      />
                                      <Line
                                        dataKey="ammoniaPpm"
                                        name="氨气 ppm"
                                        stroke="#d49a50"
                                        strokeWidth={2}
                                        dot={false}
                                      />
                                    </LineChart>
                                  </ResponsiveContainer>
                                </div>
                                {environment.data.noAlert === true && (
                                  <div className="fg-inline-warning">
                                    <AlertTriangle size={15} />
                                    环境指标超阈值，当前窗口未查询到报警记录。
                                  </div>
                                )}
                              </div>
                            )}
                            {(medication || vaccination) && (
                              <div className="fg-two-column">
                                {medication && (
                                  <CompactEvidence
                                    evidence={medication}
                                    onOpen={() => setViewEvidence(medication)}
                                  />
                                )}
                                {vaccination && (
                                  <CompactEvidence
                                    evidence={vaccination}
                                    onOpen={() => setViewEvidence(vaccination)}
                                  />
                                )}
                              </div>
                            )}
                            {detail.report && (
                              <div className="fg-report-callout">
                                <div className="fg-report-callout-icon">
                                  <FileText size={21} />
                                </div>
                                <div>
                                  <strong>核查报告已生成</strong>
                                  <p>{detail.report.summary}</p>
                                </div>
                                <button
                                  className="fg-btn fg-btn-outline fg-btn-small"
                                  onClick={() => setTab('report')}
                                >
                                  查看报告
                                  <ArrowRight size={13} />
                                </button>
                              </div>
                            )}
                          </>
                        )}
                        {tab === 'report' && (
                          <>
                            {!detail.report ? (
                              <Empty
                                title={busy ? '报告生成中' : '尚未生成报告'}
                              >
                                调查完成后展示风险、已核查方向、建议动作与证据引用。
                              </Empty>
                            ) : (
                              <ReportView
                                detail={detail}
                                busy={busy}
                                onEvidence={openEvidence}
                                onConfirm={() => {
                                  setConfirmationNote('');
                                  setConfirmationDecision(
                                    detail.report?.status === 'needs_review'
                                      ? 'needs_review'
                                      : 'confirmed',
                                  );
                                  setConfirming(true);
                                }}
                                onExport={() =>
                                  download(
                                    `FarmGuard-${detail.id}-报告.md`,
                                    reportMarkdown(detail),
                                    'text/markdown;charset=utf-8',
                                  )
                                }
                              />
                            )}
                          </>
                        )}
                        {tab === 'evidence' && (
                          <>
                            <div className="fg-section-title">
                              <div>
                                <h3>原始证据与快照</h3>
                                <p>
                                  按案件与任务保存工具返回，引用保留数据来源和规则版本。
                                </p>
                              </div>
                              <span className="fg-small-tag">
                                {detail.evidence.length} 份证据
                              </span>
                            </div>
                            {detail.evidence.length ? (
                              <div className="fg-evidence-list">
                                {detail.evidence.map((item) => (
                                  <EvidenceCard
                                    key={item.id}
                                    evidence={item}
                                    onOpen={() => setViewEvidence(item)}
                                  />
                                ))}
                              </div>
                            ) : (
                              <Empty title="等待工具取证">
                                启动调查后，工具结果将保存到当前案件。
                              </Empty>
                            )}
                          </>
                        )}
                        {tab === 'trace' && (
                          <>
                            <div className="fg-section-title">
                              <div>
                                <h3>执行记录</h3>
                                <p>
                                  从任务受理到人工确认，按事件顺序回看调查。
                                </p>
                              </div>
                              <button
                                className="fg-btn fg-btn-outline fg-btn-small"
                                disabled={Boolean(pending)}
                                onClick={() =>
                                  void operate('export', async () => {
                                    const data = await farmguardCall(
                                      'exportTrace',
                                      { caseId: detail.id },
                                    );
                                    download(
                                      `FarmGuard-${detail.id}-trace.json`,
                                      JSON.stringify(data, null, 2),
                                    );
                                  })
                                }
                              >
                                <ArrowDownToLine size={14} />
                                导出 Trace
                              </button>
                            </div>
                            {detail.trace.length ? (
                              <div className="fg-trace">
                                {detail.trace.map((event) => (
                                  <div
                                    className="fg-trace-event"
                                    key={event.id}
                                  >
                                    <span
                                      className={`fg-trace-dot ${event.type.includes('error') ? 'fg-trace-error' : ''}`}
                                    />
                                    <div className="fg-trace-time">
                                      {formatDate(event.timestamp, true)}
                                    </div>
                                    <div className="fg-trace-event-main">
                                      <div>
                                        <strong>{event.message}</strong>
                                        <span className="fg-small-tag">
                                          {event.type}
                                        </span>
                                      </div>
                                      <p>
                                        {STEP_LABELS[event.step] ?? event.step}
                                        {event.toolName &&
                                          ` · ${TOOL_LABELS[event.toolName] ?? event.toolName}`}
                                      </p>
                                      {event.evidenceIds.length > 0 && (
                                        <div className="fg-evidence-refs">
                                          {event.evidenceIds.map((id) => (
                                            <button
                                              key={id}
                                              onClick={() => openEvidence(id)}
                                            >
                                              {id.slice(-10)}
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                      {event.parameters && (
                                        <details>
                                          <summary>查看调用参数</summary>
                                          <pre>
                                            {JSON.stringify(
                                              event.parameters,
                                              null,
                                              2,
                                            )}
                                          </pre>
                                        </details>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <Empty title="尚无执行记录">
                                启动调查后记录工具参数、进度和证据。
                              </Empty>
                            )}
                          </>
                        )}
                        {tab === 'context' && (
                          <>
                            <div className="fg-section-title">
                              <div>
                                <h3>上下文预算与保留内容</h3>
                                <p>
                                  按字符预算组装规则、案件范围、待办与证据卡。
                                </p>
                              </div>
                              <span className="fg-small-tag">Context Plan</span>
                            </div>
                            <div className="fg-context-budget">
                              <label>
                                输入预算
                                <input
                                  type="number"
                                  min={100}
                                  max={50_000}
                                  step={100}
                                  value={contextBudget}
                                  onChange={(event) => {
                                    const value = Number(event.target.value);
                                    if (value >= 100 && value <= 50_000)
                                      setContextBudget(value);
                                  }}
                                />
                                <span>字符</span>
                              </label>
                              <span>
                                字符预算用于内容裁剪；实际模型窗口还需按模型分词计量。
                              </span>
                            </div>
                            {!contextPlan ? (
                              <div className="fg-loading">
                                <Loader2 size={20} className="fg-spin" />
                                组装上下文计划
                              </div>
                            ) : (
                              <>
                                <div
                                  className={`fg-context-summary fg-context-${contextPlan.action}`}
                                >
                                  <div>
                                    <strong>
                                      {contextPlan.action === 'ready'
                                        ? '预算内可执行'
                                        : contextPlan.action === 'split'
                                          ? '切换单节点执行'
                                          : '最小上下文仍超限'}
                                    </strong>
                                    <span>
                                      {contextPlan.totalChars.toLocaleString()}{' '}
                                      /{' '}
                                      {contextPlan.budgetChars.toLocaleString()}{' '}
                                      字符
                                    </span>
                                  </div>
                                  <div className="fg-context-meter">
                                    <span
                                      style={{
                                        width: `${Math.min(100, (contextPlan.totalChars / contextPlan.budgetChars) * 100)}%`,
                                      }}
                                    />
                                  </div>
                                  <p>{contextPlan.reason}</p>
                                </div>
                                <div className="fg-section-title">
                                  <div>
                                    <h3>Context Blocks</h3>
                                    <p>
                                      {contextPlan.blocks.length} 个块 ·{' '}
                                      {contextPlan.preservedEvidenceIds.length}{' '}
                                      份证据引用
                                    </p>
                                  </div>
                                  <span className="fg-small-tag">
                                    {contextPlan.executionMode ===
                                    'whole_investigation'
                                      ? '完整调查'
                                      : contextPlan.executionMode ===
                                          'single_node'
                                        ? '当前节点'
                                        : '阻断请求'}
                                  </span>
                                </div>
                                <div className="fg-context-blocks">
                                  {contextPlan.blocks.map((block) => (
                                    <details
                                      key={block.id}
                                      className="fg-context-block"
                                    >
                                      <summary>
                                        <span>{block.role}</span>
                                        <strong>{block.id}</strong>
                                        <small>
                                          {block.content.length} 字符
                                        </small>
                                        <span className="fg-small-tag">
                                          {block.protected ? '保留' : '可裁剪'}{' '}
                                          · P{block.priority}
                                        </span>
                                        <ChevronRight size={14} />
                                      </summary>
                                      <pre>{block.content}</pre>
                                      <div className="fg-evidence-refs">
                                        {block.sourceIds.map((id) =>
                                          detail.evidence.some(
                                            (item) => item.id === id,
                                          ) ? (
                                            <button
                                              key={id}
                                              onClick={() => openEvidence(id)}
                                            >
                                              {id.slice(-10)}
                                            </button>
                                          ) : (
                                            <span key={id}>{id}</span>
                                          ),
                                        )}
                                      </div>
                                    </details>
                                  ))}
                                </div>
                                {contextPlan.trimmed.length > 0 && (
                                  <div className="fg-context-trimmed">
                                    <h3>本次移除的可恢复内容</h3>
                                    <p>{contextPlan.trimmed.join(' · ')}</p>
                                  </div>
                                )}
                              </>
                            )}
                          </>
                        )}
                      </div>
                    </>
                  )}
                </section>
              </div>
            </>
          )}
          {section === 'memory' && (
            <>
              <div className="fg-page-heading">
                <div>
                  <span className="fg-eyebrow">
                    KNOWLEDGE / STRUCTURED MEMORY
                  </span>
                  <h1>结构化记忆</h1>
                  <p>用适用范围筛选候选记录，再检索可复用的事实与决策。</p>
                </div>
                <span className="fg-page-tag">
                  <Database size={16} />
                  FTS5 / BM25
                </span>
              </div>
              <section className="fg-panel fg-memory-search">
                <div className="fg-section-title">
                  <div>
                    <h3>检索调查记忆</h3>
                    <p>
                      当前处置建议按规则版本筛选；历史事实单独标注时间与来源。
                    </p>
                  </div>
                </div>
                <div className="fg-memory-query">
                  <label className="fg-search">
                    <Search size={18} />
                    <input
                      placeholder="输入关键词，例如：环境、死亡、库存、防疫"
                      value={memoryQuery}
                      onChange={(event) => setMemoryQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void searchMemory();
                      }}
                    />
                  </label>
                  <button
                    className="fg-btn fg-btn-primary"
                    disabled={Boolean(pending)}
                    onClick={() => void searchMemory()}
                  >
                    {pending === 'memory' ? (
                      <Loader2 size={16} className="fg-spin" />
                    ) : (
                      <Search size={16} />
                    )}
                    检索记忆
                  </button>
                </div>
                <div className="fg-memory-filters">
                  <label>
                    养殖场
                    <select
                      value={memoryFarm}
                      onChange={(event) => setMemoryFarm(event.target.value)}
                    >
                      <option value="">全部养殖场</option>
                      {farmIds.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    批次
                    <select
                      value={memoryBatch}
                      onChange={(event) => setMemoryBatch(event.target.value)}
                    >
                      <option value="">全部批次</option>
                      {batchIds.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    记忆类型
                    <select
                      value={memoryKind}
                      disabled={historicalFacts}
                      onChange={(event) => setMemoryKind(event.target.value)}
                    >
                      <option value="">全部类型</option>
                      {Object.entries(KIND_LABELS).map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    规则版本
                    <select
                      value={memoryRule}
                      disabled={historicalFacts}
                      onChange={(event) => setMemoryRule(event.target.value)}
                    >
                      <option value="">当前版本 {currentRule?.version}</option>
                      {rules.map((rule) => (
                        <option key={rule.id} value={rule.version}>
                          {rule.version}
                          {rule.current ? ' · 当前' : ' · 历史'}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="fg-filter-dates fg-memory-dates">
                  <span>
                    <CalendarDays size={14} />
                    记录时间窗
                  </span>
                  <input
                    type="date"
                    aria-label="记忆时间窗开始"
                    value={memoryStart}
                    max={memoryEnd || undefined}
                    onChange={(event) => setMemoryStart(event.target.value)}
                  />
                  <span>至</span>
                  <input
                    type="date"
                    aria-label="记忆时间窗结束"
                    value={memoryEnd}
                    min={memoryStart || undefined}
                    onChange={(event) => setMemoryEnd(event.target.value)}
                  />
                </div>
                <label className="fg-checkbox">
                  <input
                    type="checkbox"
                    checked={historicalFacts}
                    onChange={(event) => {
                      setHistoricalFacts(event.target.checked);
                      if (event.target.checked) setMemoryKind('fact');
                    }}
                  />
                  <span>仅检索历史事实（跨规则版本，标明时间与来源）</span>
                </label>
              </section>
              <section className="fg-panel fg-memory-results">
                <div className="fg-panel-heading">
                  <h2>
                    检索结果 {memorySearched && <span>{memory.length}</span>}
                  </h2>
                  <span>范围过滤 → 相关性排序 → 读取记录</span>
                </div>
                {!memorySearched ? (
                  <Empty title="按当前调查检索相关记录">
                    完成调查后，事实、决策与未完成事项会写入记忆。
                  </Empty>
                ) : !memory.length ? (
                  <Empty title="当前条件下没有可复用记忆">
                    可依据当前规则和本次数据继续调查。
                  </Empty>
                ) : (
                  <div className="fg-memory-list">
                    {memory.map((item) => (
                      <article key={item.id} className="fg-memory-card">
                        <div className="fg-memory-card-top">
                          <span
                            className={`fg-memory-kind fg-memory-kind-${item.kind}`}
                          >
                            {KIND_LABELS[item.kind]}
                          </span>
                          {item.historical && (
                            <span className="fg-small-tag">历史事实</span>
                          )}
                          <span>{formatDate(item.createdAt, true)}</span>
                        </div>
                        <h3>{item.title}</h3>
                        <p>{item.body}</p>
                        <div className="fg-memory-card-meta">
                          <span>{item.farmId}</span>
                          <span>{item.batchId}</span>
                          <span>
                            {item.startDate} — {item.endDate}
                          </span>
                          <span>{item.ruleVersion}</span>
                        </div>
                        <div className="fg-memory-card-source">
                          <span>来源：{item.source}</span>
                          <span>{item.evidenceIds.length} 条证据引用</span>
                        </div>
                        {item.caseId && (
                          <button
                            className="fg-text-button"
                            onClick={() => {
                              setSection('investigations');
                              setSelectedId(item.caseId!);
                              setTab('report');
                            }}
                          >
                            回到关联调查 <ArrowRight size={13} />
                          </button>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
          {section === 'rules' && (
            <>
              <div className="fg-page-heading">
                <div>
                  <span className="fg-eyebrow">GOVERNANCE / RULE PACKS</span>
                  <h1>规则与版本</h1>
                  <p>
                    查看调查阈值、生效时间与核查要求，追溯每份报告采用的规则。
                  </p>
                </div>
                <span className="fg-page-tag">
                  <ShieldCheck size={16} />
                  {rules.length} 个版本
                </span>
              </div>
              <div className="fg-rules-list">
                {rules.map((rule) => (
                  <section
                    key={rule.id}
                    className={`fg-panel fg-rule-pack ${rule.current ? 'fg-rule-current' : ''}`}
                  >
                    <div className="fg-rule-header">
                      <div>
                        <div className="fg-rule-icon">
                          <ShieldCheck size={24} />
                        </div>
                        <div>
                          <h2>{rule.title}</h2>
                          <p>
                            {rule.version} · {rule.effectiveFrom} 起生效
                            {rule.effectiveTo ? `，至 ${rule.effectiveTo}` : ''}
                          </p>
                        </div>
                      </div>
                      <span
                        className={`fg-badge fg-badge-${rule.current ? 'green' : 'neutral'}`}
                      >
                        <span />
                        {rule.current ? '当前规则' : '历史版本'}
                      </span>
                    </div>
                    <div className="fg-rule-thresholds">
                      <div>
                        <span>死亡率调查阈值</span>
                        <strong>
                          {rule.thresholds.weeklyDeathRatePct}
                          <small>%</small>
                        </strong>
                      </div>
                      <div>
                        <span>环境温度阈值</span>
                        <strong>
                          {rule.thresholds.temperatureC}
                          <small> °C</small>
                        </strong>
                      </div>
                      <div>
                        <span>氨气浓度阈值</span>
                        <strong>
                          {rule.thresholds.ammoniaPpm}
                          <small> ppm</small>
                        </strong>
                      </div>
                    </div>
                    <div className="fg-rule-items">
                      {rule.rules.map((item, index) => (
                        <div key={item.id}>
                          <span>{String(index + 1).padStart(2, '0')}</span>
                          <div>
                            <strong>{item.title}</strong>
                            <p>{item.description}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="fg-rule-notice">{rule.notice}</p>
                  </section>
                ))}
              </div>
            </>
          )}
          <footer className="fg-footer">
            <span>FarmGuard · 证据驱动的养殖风险调查</span>
            <span>SOP · Structured Memory · Trace</span>
          </footer>
        </main>
      </div>
      {newCase && (
        <div
          className="fg-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !pending)
              setNewCase(false);
          }}
        >
          <section
            className="fg-modal fg-create-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fg-new-title"
          >
            <div className="fg-modal-heading">
              <div>
                <span className="fg-eyebrow">NEW INVESTIGATION</span>
                <h2 id="fg-new-title">新建调查</h2>
                <p>确定调查范围与样例数据，启动完整 SOP 核查。</p>
              </div>
              <button
                className="fg-icon-btn"
                aria-label="关闭新建调查"
                onClick={() => setNewCase(false)}
              >
                <X size={20} />
              </button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void operate('create', async () => {
                  const created = await farmguardCall<FarmCase>(
                    'createCase',
                    create,
                  );
                  setSelectedId(created.id);
                  setTab('overview');
                  setSection('investigations');
                  setNewCase(false);
                  await refresh(false);
                  setNotice('调查已创建。点击“启动调查”开始核查。');
                });
              }}
            >
              <label className="fg-field">
                调查名称
                <input
                  value={create.title}
                  placeholder="例如：3 号猪舍本周死亡率异常排查"
                  onChange={(event) =>
                    setCreate({ ...create, title: event.target.value })
                  }
                />
              </label>
              <div className="fg-form-grid">
                <label className="fg-field">
                  养殖场
                  <input
                    required
                    value={create.farmId}
                    onChange={(event) =>
                      setCreate({ ...create, farmId: event.target.value })
                    }
                  />
                </label>
                <label className="fg-field">
                  猪舍
                  <input
                    required
                    value={create.barnId}
                    onChange={(event) =>
                      setCreate({ ...create, barnId: event.target.value })
                    }
                  />
                </label>
                <label className="fg-field fg-field-wide">
                  批次
                  <input
                    required
                    value={create.batchId}
                    onChange={(event) =>
                      setCreate({ ...create, batchId: event.target.value })
                    }
                  />
                </label>
                <label className="fg-field">
                  开始日期
                  <input
                    type="date"
                    required
                    value={create.startDate}
                    max={create.endDate}
                    onChange={(event) =>
                      setCreate({ ...create, startDate: event.target.value })
                    }
                  />
                </label>
                <label className="fg-field">
                  结束日期
                  <input
                    type="date"
                    required
                    value={create.endDate}
                    min={create.startDate}
                    onChange={(event) =>
                      setCreate({ ...create, endDate: event.target.value })
                    }
                  />
                </label>
              </div>
              <label className="fg-field">
                调查样例
                <select
                  value={create.scenario}
                  onChange={(event) =>
                    setCreate({
                      ...create,
                      scenario: event.target.value as ScenarioId,
                    })
                  }
                >
                  {SCENARIOS.map((scenario) => (
                    <option key={scenario.id} value={scenario.id}>
                      {scenario.label}
                    </option>
                  ))}
                </select>
                <small>
                  {
                    SCENARIOS.find(
                      (scenario) => scenario.id === create.scenario,
                    )?.description
                  }
                </small>
              </label>
              <div className="fg-modal-actions">
                <button
                  type="button"
                  className="fg-btn fg-btn-outline"
                  onClick={() => setNewCase(false)}
                >
                  取消
                </button>
                <button
                  className="fg-btn fg-btn-primary"
                  disabled={Boolean(pending)}
                >
                  {pending === 'create' ? (
                    <Loader2 size={16} className="fg-spin" />
                  ) : (
                    <Plus size={16} />
                  )}
                  创建调查
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {viewEvidence && (
        <div
          className="fg-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setViewEvidence(null);
          }}
        >
          <section
            className="fg-modal fg-evidence-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fg-evidence-title"
          >
            <div className="fg-modal-heading">
              <div>
                <span className="fg-eyebrow">SOURCE EVIDENCE</span>
                <h2 id="fg-evidence-title">
                  {TOOL_LABELS[viewEvidence.toolName] ?? viewEvidence.toolName}
                </h2>
                <p>{viewEvidence.summary}</p>
              </div>
              <button
                className="fg-icon-btn"
                aria-label="关闭证据"
                onClick={() => setViewEvidence(null)}
              >
                <X size={20} />
              </button>
            </div>
            <div className="fg-evidence-modal-body">
              <dl className="fg-evidence-metadata">
                <div>
                  <dt>证据编号</dt>
                  <dd>{viewEvidence.id}</dd>
                </div>
                <div>
                  <dt>数据来源</dt>
                  <dd>{viewEvidence.source}</dd>
                </div>
                <div>
                  <dt>快照时间</dt>
                  <dd>{formatDate(viewEvidence.sourceTimestamp, true)}</dd>
                </div>
                <div>
                  <dt>规则版本</dt>
                  <dd>{viewEvidence.ruleVersion}</dd>
                </div>
                <div>
                  <dt>调查范围</dt>
                  <dd>
                    {viewEvidence.scope.farmId} / {viewEvidence.scope.barnId} /{' '}
                    {viewEvidence.scope.batchId}
                  </dd>
                </div>
                <div>
                  <dt>时间窗</dt>
                  <dd>
                    {viewEvidence.scope.startDate} —{' '}
                    {viewEvidence.scope.endDate}
                  </dd>
                </div>
                <div>
                  <dt>快照校验值</dt>
                  <dd className="fg-hash">{viewEvidence.snapshotHash}</dd>
                </div>
              </dl>
              <h3>工具返回原始数据</h3>
              <pre className="fg-json">
                {JSON.stringify(viewEvidence.data, null, 2)}
              </pre>
            </div>
            <div className="fg-modal-actions">
              <button
                className="fg-btn fg-btn-outline"
                onClick={() =>
                  download(
                    `FarmGuard-${viewEvidence.id}.json`,
                    JSON.stringify(viewEvidence, null, 2),
                  )
                }
              >
                <ArrowDownToLine size={15} />
                导出证据
              </button>
              <button
                className="fg-btn fg-btn-primary"
                onClick={() => setViewEvidence(null)}
              >
                关闭
              </button>
            </div>
          </section>
        </div>
      )}
      {confirming && detail?.report && (
        <div className="fg-modal-backdrop">
          <section
            className="fg-modal fg-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fg-confirm-title"
          >
            <div className="fg-modal-heading">
              <div>
                <span className="fg-eyebrow">HUMAN REVIEW</span>
                <h2 id="fg-confirm-title">人工确认报告</h2>
                <p>保存复核结论与备注，保留在案件执行记录中。</p>
              </div>
              <button
                className="fg-icon-btn"
                aria-label="关闭人工确认"
                onClick={() => setConfirming(false)}
              >
                <X size={20} />
              </button>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void operate('confirm', async () => {
                  const updated = await farmguardCall<CaseDetail>(
                    'confirmReport',
                    {
                      caseId: detail.id,
                      decision: confirmationDecision,
                      note: confirmationNote,
                    },
                  );
                  setDetail(updated);
                  setConfirming(false);
                  await refresh();
                  setNotice(
                    confirmationDecision === 'confirmed'
                      ? '报告已确认，复核记录已保存。'
                      : '已标记待复核，备注已保存。',
                  );
                });
              }}
            >
              <label className="fg-field">
                复核结论
                <select
                  value={confirmationDecision}
                  onChange={(event) =>
                    setConfirmationDecision(
                      event.target.value as 'confirmed' | 'needs_review',
                    )
                  }
                >
                  <option
                    value="confirmed"
                    disabled={detail.report.status === 'needs_review'}
                  >
                    确认调查报告
                  </option>
                  <option value="needs_review">仍需人工复核</option>
                </select>
              </label>
              <label className="fg-field">
                复核备注
                <textarea
                  required
                  rows={4}
                  value={confirmationNote}
                  placeholder="记录核实依据、未解决问题或下一步安排"
                  onChange={(event) => setConfirmationNote(event.target.value)}
                />
              </label>
              <div className="fg-modal-actions">
                <button
                  type="button"
                  className="fg-btn fg-btn-outline"
                  onClick={() => setConfirming(false)}
                >
                  取消
                </button>
                <button
                  className="fg-btn fg-btn-primary"
                  disabled={Boolean(pending)}
                >
                  {pending === 'confirm' ? (
                    <Loader2 size={16} className="fg-spin" />
                  ) : (
                    <ClipboardCheck size={16} />
                  )}
                  保存确认
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  foot,
  tone = 'neutral',
}: {
  icon: ReactNode;
  label: string;
  value: number;
  foot: string;
  tone?: string;
}) {
  return (
    <article className={`fg-stat fg-stat-${tone}`}>
      <div className="fg-stat-header">
        <span>{label}</span>
        <div>{icon}</div>
      </div>
      <strong>
        {value}
        <small>条</small>
      </strong>
      <p>{foot}</p>
    </article>
  );
}
function CompactEvidence({
  evidence,
  onOpen,
}: {
  evidence: Evidence;
  onOpen: () => void;
}) {
  const data = evidence.data;
  const isMedication = evidence.toolName === 'medication_inventory';
  const dataRows = rows(data.rows);
  const abnormal = isMedication
    ? rows(data.mismatches).length > 0
    : dataRows.some((row) => row.status !== 'completed');
  return (
    <article className="fg-compact-evidence">
      <div>
        <h3>{TOOL_LABELS[evidence.toolName]}</h3>
        <span
          className={`fg-small-tag ${abnormal ? 'fg-text-amber' : 'fg-text-green'}`}
        >
          {abnormal ? '发现差异' : '核查完成'}
        </span>
      </div>
      <p>{evidence.summary}</p>
      <div className="fg-mini-table">
        {isMedication ? (
          <table>
            <thead>
              <tr>
                <th>记录</th>
                <th>登记</th>
                <th>出库</th>
              </tr>
            </thead>
            <tbody>
              {dataRows.map((row, index) => (
                <tr key={index}>
                  <td>{String(row.drug).replace('（不含处方）', '')}</td>
                  <td>{String(row.usedUnits)}</td>
                  <td
                    className={
                      row.usedUnits !== row.inventoryOutUnits
                        ? 'fg-text-amber'
                        : ''
                    }
                  >
                    {String(row.inventoryOutUnits)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <th>记录</th>
                <th>计划</th>
                <th>实际</th>
              </tr>
            </thead>
            <tbody>
              {dataRows.map((row, index) => (
                <tr key={index}>
                  <td>{String(row.vaccine)}</td>
                  <td>{String(row.scheduledDate).slice(5)}</td>
                  <td
                    className={
                      row.status !== 'completed' ? 'fg-text-amber' : ''
                    }
                  >
                    {String(row.completedDate ?? '缺失').slice(5)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <button className="fg-text-button" onClick={onOpen}>
        查看证据 <ArrowRight size={12} />
      </button>
    </article>
  );
}
function EvidenceCard({
  evidence,
  onOpen,
}: {
  evidence: Evidence;
  onOpen: () => void;
}) {
  return (
    <article className="fg-evidence-card">
      <div className="fg-evidence-card-icon">
        <Database size={19} />
      </div>
      <div className="fg-evidence-card-content">
        <div>
          <h3>{TOOL_LABELS[evidence.toolName] ?? evidence.toolName}</h3>
          <span>{formatDate(evidence.createdAt, true)}</span>
        </div>
        <p>{evidence.summary}</p>
        <div className="fg-evidence-card-meta">
          <code>{evidence.id}</code>
          <span>{evidence.source}</span>
          <span>{evidence.ruleVersion}</span>
        </div>
      </div>
      <button className="fg-btn fg-btn-outline fg-btn-small" onClick={onOpen}>
        查看快照
        <ChevronRight size={13} />
      </button>
    </article>
  );
}
function ReportView({
  detail,
  busy,
  onEvidence,
  onConfirm,
  onExport,
}: {
  detail: CaseDetail;
  busy: boolean;
  onEvidence: (id: string) => void;
  onConfirm: () => void;
  onExport: () => void;
}) {
  const report = detail.report!;
  return (
    <div className="fg-report">
      <div className={`fg-report-summary fg-report-${report.status}`}>
        <div className="fg-report-summary-top">
          <div>
            <FileText size={20} />
            <strong>{report.title}</strong>
          </div>
          <Badge status={report.status} />
        </div>
        <p>{report.summary}</p>
        <div className="fg-report-meta">
          <span>{report.ruleVersion}</span>
          <span>{formatDate(report.generatedAt, true)}</span>
          <span>{report.evidenceIds.length} 份证据</span>
        </div>
      </div>
      <div className="fg-section-title">
        <div>
          <h3>核查发现</h3>
          <p>每项发现关联规则与原始证据。</p>
        </div>
      </div>
      <div className="fg-findings">
        {report.findings.map((finding) => (
          <article
            key={finding.id}
            className={`fg-finding fg-finding-${finding.severity}`}
          >
            <div>
              {finding.severity === 'info' ? (
                <CheckCircle2 size={18} />
              ) : (
                <AlertTriangle size={18} />
              )}
            </div>
            <div>
              <h4>{finding.title}</h4>
              <p>{finding.summary}</p>
              <div className="fg-evidence-refs">
                {finding.evidenceIds.map((id) => (
                  <button key={id} onClick={() => onEvidence(id)}>
                    <Database size={11} />
                    {id.slice(-10)}
                  </button>
                ))}
                <span>规则 {finding.ruleId}</span>
              </div>
            </div>
          </article>
        ))}
      </div>
      <div className="fg-section-title">
        <div>
          <h3>已核查方向</h3>
          <p>包括未发现异常的排除性取证。</p>
        </div>
      </div>
      <div className="fg-checked-directions">
        {report.checkedDirections.map((item, index) => (
          <div key={index}>
            <CheckCircle2 size={16} />
            <div>
              <strong>{item.direction}</strong>
              <p>{item.outcome}</p>
              <div className="fg-evidence-refs">
                {item.evidenceIds.map((id) => (
                  <button key={id} onClick={() => onEvidence(id)}>
                    {id.slice(-10)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      {report.unresolvedQuestions.length > 0 && (
        <div className="fg-unresolved">
          <h3>
            <AlertTriangle size={17} />
            需要人工核实
          </h3>
          <ul>
            {report.unresolvedQuestions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="fg-next-actions">
        <h3>下一步建议</h3>
        {report.recommendedActions.map((action, index) => (
          <div key={index}>
            <span>{index + 1}</span>
            <p>{action}</p>
          </div>
        ))}
      </div>
      {report.confirmation && (
        <div className="fg-confirmation-record">
          <ClipboardCheck size={18} />
          <div>
            <strong>
              {report.confirmation.decision === 'confirmed'
                ? '报告已人工确认'
                : '报告待进一步复核'}
            </strong>
            <p>{report.confirmation.note}</p>
            <small>
              {report.confirmation.actor} ·{' '}
              {formatDate(report.confirmation.timestamp, true)}
            </small>
          </div>
        </div>
      )}
      <div className="fg-report-actions">
        <span>
          <Clock3 size={14} />
          {report.confirmation
            ? '已保存人工复核记录'
            : busy
              ? '调查执行中，等待新报告'
              : '等待人工复核与确认'}
        </span>
        <div>
          <button className="fg-btn fg-btn-outline" onClick={onExport}>
            <ArrowDownToLine size={15} />
            导出报告
          </button>
          <button
            className="fg-btn fg-btn-primary"
            onClick={onConfirm}
            disabled={busy || Boolean(report.confirmation)}
          >
            <ClipboardCheck size={16} />
            {report.confirmation ? '已记录复核' : '人工确认'}
          </button>
        </div>
      </div>
    </div>
  );
}
function reportMarkdown(detail: CaseDetail) {
  const report = detail.report!;
  return `# ${report.title}\n\n调查：${detail.id}\n\n养殖场：${detail.farmId} / 猪舍：${detail.barnId} / 批次：${detail.batchId}\n\n时间窗：${detail.startDate} — ${detail.endDate}\n\n规则版本：${report.ruleVersion}\n\n${report.summary}\n\n## 核查发现\n\n${report.findings.map((finding) => `### ${finding.title}\n\n${finding.summary}\n\n证据：${finding.evidenceIds.join('、')}\n\n规则：${finding.ruleId}`).join('\n\n')}\n\n## 已核查方向\n\n${report.checkedDirections.map((item) => `- ${item.direction}：${item.outcome}（${item.evidenceIds.join('、')}）`).join('\n')}\n\n## 待核实问题\n\n${report.unresolvedQuestions.map((item) => `- ${item}`).join('\n') || '无'}\n\n## 下一步建议\n\n${report.recommendedActions.map((item) => `- ${item}`).join('\n')}\n\n## 人工确认\n\n${report.confirmation ? `${report.confirmation.actor} / ${report.confirmation.decision}\n\n${report.confirmation.note}` : '等待确认'}\n\n生成时间：${report.generatedAt}\n`;
}
