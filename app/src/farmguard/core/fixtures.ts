import type { FarmCase, RulePack, ScenarioId } from './types.js';

export const CURRENT_RULE_VERSION = 'FG-2026.10';
export const SCENARIOS: {
  id: ScenarioId;
  title: string;
  description: string;
}[] = [
  {
    id: 'normal',
    title: '正常批次',
    description: '死亡率未超过阈值，SOP 在死亡率门槛处停止。',
  },
  {
    id: 'environment_no_alert',
    title: '环境恶化未报警',
    description: '死亡率偏高、环境曲线异常，但报警记录为空。',
  },
  {
    id: 'medication_mismatch',
    title: '用药与库存不一致',
    description: '异常批次中，用药登记与库存出库数量不一致。',
  },
  {
    id: 'vaccination_late',
    title: '防疫记录延迟',
    description: '异常批次中，防疫实际完成日期晚于计划日期。',
  },
  {
    id: 'ambiguous',
    title: '统计口径冲突',
    description: '同一日死亡数存在缺少版本依据的 7 / 9 冲突，需人工核实。',
  },
];

export const RULE_PACKS: RulePack[] = [
  {
    id: 'rules-current',
    title: '养殖风险排查规则',
    version: CURRENT_RULE_VERSION,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    current: true,
    thresholds: { weeklyDeathRatePct: 1, temperatureC: 30, ammoniaPpm: 20 },
    rules: [
      {
        id: 'mortality_gate',
        title: '死亡率门槛',
        description:
          '窗口死亡率超过 1% 才启动异常死亡调查；未超过时只保留统计证据。',
      },
      {
        id: 'environment_alert',
        title: '环境与报警核对',
        description:
          '温度 >30°C 或氨气 >20ppm 记录为环境风险，同时核对报警记录。',
      },
      {
        id: 'medication_inventory',
        title: '用药与库存一致性',
        description: '逐条核对用药登记数量与库存出库数量；差异提示人工复查。',
      },
      {
        id: 'vaccination_schedule',
        title: '防疫记录核验',
        description:
          '核对计划日期、完成日期与缺失项；记录正常只表示该记录核查未发现异常。',
      },
      {
        id: 'evidence_boundary',
        title: '证据与结论边界',
        description:
          '环境异常与死亡率同期升高不构成因果证明；冲突不得由模型猜测修正。',
      },
      {
        id: 'human_confirmation',
        title: '人工确认',
        description:
          '报告必须人工确认；工具不执行用药调整、客户发送或真实业务处置。',
      },
    ],
    notice:
      '合成演示规则与阈值，用于展示调查工作流，不构成兽医诊断或真实养殖处置建议。',
  },
  {
    id: 'rules-previous',
    title: '养殖风险排查规则（历史）',
    version: 'FG-2025.01',
    effectiveFrom: '2025-01-01',
    effectiveTo: '2025-12-31',
    current: false,
    thresholds: { weeklyDeathRatePct: 2, temperatureC: 32, ammoniaPpm: 25 },
    rules: [
      {
        id: 'historical_only',
        title: '历史版本',
        description: '仅用于核对历史事实，不作为当前处置建议。',
      },
    ],
    notice: '历史演示版本。',
  },
];

function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  for (let ms = Date.parse(start); ms <= Date.parse(end); ms += 86_400_000)
    days.push(new Date(ms).toISOString().slice(0, 10));
  return days;
}

export function fixtureFor(
  farmCase: FarmCase,
  toolName: string,
  rules: RulePack,
): { summary: string; data: Record<string, unknown> } {
  const days = daysBetween(farmCase.startDate, farmCase.endDate);
  const dates = days.length ? days : [farmCase.startDate];
  if (toolName === 'mortality_stats') {
    const pattern =
      farmCase.scenario === 'normal'
        ? [1, 0, 1, 1, 1, 1, 1]
        : [2, 2, 3, 5, 5, 4, 3];
    const daily = dates.map((date, i) => ({
      date,
      deaths: pattern[i % pattern.length] ?? 0,
    }));
    const totalDeaths = daily.reduce((sum, row) => sum + row.deaths, 0);
    const deathRatePct = Number(((totalDeaths / 1_000) * 100).toFixed(2));
    const conflicts =
      farmCase.scenario === 'ambiguous'
        ? [
            {
              date: dates[2] ?? dates[0],
              values: [7, 9],
              sources: ['死亡登记快照 A', '死亡登记快照 B'],
              versionRelation: null,
              resolution: 'unresolved',
            },
          ]
        : [];
    return {
      summary: `窗口死亡 ${totalDeaths} 头 / 期初 1000 头，死亡率 ${deathRatePct}%${conflicts.length ? '；存在 7 / 9 未解决冲突' : ''}`,
      data: {
        daily,
        openingHeadcount: 1_000,
        totalDeaths,
        deathRatePct,
        thresholdPct: rules.thresholds.weeklyDeathRatePct,
        exceedsThreshold: deathRatePct > rules.thresholds.weeklyDeathRatePct,
        conflicts,
      },
    };
  }
  if (toolName === 'environment_series') {
    const abnormal = farmCase.scenario === 'environment_no_alert';
    const timeseries = dates.flatMap((date, day) =>
      [8, 14, 20].map((hour) => {
        const impacted = abnormal && day >= 2 && day <= 5 && hour === 14;
        return {
          timestamp: `${date}T${String(hour).padStart(2, '0')}:00:00+08:00`,
          temperatureC: impacted ? 34.5 : 25 + (day % 3),
          humidityPct: impacted ? 86 : 65,
          ammoniaPpm: impacted ? 29 : 10 + (day % 4),
          fanRunning: !impacted,
        };
      }),
    );
    const peakTemperatureC = Math.max(
      ...timeseries.map((row) => row.temperatureC),
    );
    const peakAmmoniaPpm = Math.max(...timeseries.map((row) => row.ammoniaPpm));
    return {
      summary: abnormal
        ? '环境温度与氨气超阈值，合成风机状态为停止，报警记录为空'
        : '本时间窗环境数据未超过演示阈值',
      data: {
        timeseries,
        alerts: [],
        peakTemperatureC,
        peakAmmoniaPpm,
        abnormal,
        noAlert: abnormal,
        rules: rules.thresholds,
      },
    };
  }
  if (toolName === 'medication_inventory') {
    const rows = [
      {
        date: dates[1] ?? dates[0],
        drug: '合成记录药品 A（不含处方）',
        usedUnits: 12,
        inventoryOutUnits: farmCase.scenario === 'medication_mismatch' ? 8 : 12,
      },
      {
        date: dates[4] ?? dates[0],
        drug: '合成记录药品 B（不含处方）',
        usedUnits: 6,
        inventoryOutUnits: 6,
      },
    ];
    const mismatches = rows.filter(
      (row) => row.usedUnits !== row.inventoryOutUnits,
    );
    return {
      summary: mismatches.length
        ? '用药登记 12 单位，但库存出库 8 单位，存在 4 单位差异'
        : '登记用药与库存出库一致；未发现本记录核对异常',
      data: { rows, mismatches },
    };
  }
  if (toolName === 'vaccination_records') {
    const scheduledDate = dates[1] ?? dates[0] ?? farmCase.startDate;
    const completedDate =
      farmCase.scenario === 'vaccination_late'
        ? (dates[4] ?? farmCase.endDate)
        : scheduledDate;
    const rows = [
      {
        vaccine: '合成防疫记录 A',
        scheduledDate,
        completedDate,
        status: completedDate === scheduledDate ? 'completed' : 'late',
      },
    ];
    return {
      summary:
        farmCase.scenario === 'vaccination_late'
          ? '防疫实际完成晚于计划日期；需核实登记和执行情况'
          : '防疫记录齐全且按计划日期登记；不据此排除所有疾病原因',
      data: { rows },
    };
  }
  throw new Error(`不支持的调查工具：${toolName}`);
}
