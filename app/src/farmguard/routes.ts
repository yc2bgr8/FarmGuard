import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { DATA_DIR } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser } from '../types.js';
import type { Variables } from '../web-context.js';
import { FarmGuardService } from './core/index.js';
import type { FarmGuardEvent, MemoryKind, ScenarioId } from './core/types.js';
import { getRegisteredGroup } from '../db.js';

const routes = new Hono<{ Variables: Variables }>();
const services = new Map<string, FarmGuardService>();
const subscribers = new Map<string, Set<(event: FarmGuardEvent) => void>>();
let internalRequest:
  | ((route: string, body: unknown, cookie: string) => Promise<Response>)
  | undefined;
export function setFarmGuardInternalRequest(
  handler: NonNullable<typeof internalRequest>,
): void {
  internalRequest = handler;
}

async function invokeNative(route: string, body: unknown, cookie: string) {
  if (!internalRequest) throw new Error('Agent 服务尚未初始化');
  const response = await internalRequest(route, body, cookie);
  const data = (await response.json()) as Record<string, any>;
  if (!response.ok) {
    if (response.status === 409 && route === '/api/mcp-servers') return data;
    throw new Error(
      typeof data.error === 'string' ? data.error : 'Agent 配置失败',
    );
  }
  return data;
}

function serviceFor(userId: string): FarmGuardService {
  const existing = services.get(userId);
  if (existing) return existing;
  const service = new FarmGuardService({
    dataDir: path.join(DATA_DIR, 'farmguard', 'users', userId),
    onEvent: (event) => {
      for (const listener of subscribers.get(userId) ?? []) listener(event);
    },
  });
  services.set(userId, service);
  return service;
}

const requestSchema = z.object({
  action: z.string().min(1).max(80),
  payload: z.record(z.string(), z.unknown()).optional(),
});
const field = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`缺少 ${name}`);
  return value.trim();
};
const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const scenarios = new Set([
  'normal',
  'environment_no_alert',
  'medication_mismatch',
  'vaccination_late',
  'ambiguous',
]);
const memoryKinds = new Set(['fact', 'decision', 'lesson', 'open_loop']);

routes.get('/health', (c) => c.json({ ok: true, service: 'FarmGuard' }));
routes.use('*', authMiddleware);
routes.post('/call', async (c) => {
  const request = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!request.success) return c.json({ error: '请求格式不正确' }, 400);
  const user = c.get('user') as AuthUser;
  const service = serviceFor(user.id);
  const p = request.data.payload ?? {};
  try {
    switch (request.data.action) {
      case 'bootstrap':
        return c.json(service.bootstrap());
      case 'listCases':
        return c.json(service.listCases());
      case 'getCase':
        return c.json(service.getCase(field(p.caseId, 'caseId')));
      case 'getRules':
        return c.json(service.getRules());
      case 'getContextPlan':
        return c.json(
          service.getContextPlan(
            field(p.caseId, 'caseId'),
            typeof p.budgetChars === 'number' ? p.budgetChars : 6000,
          ),
        );
      case 'prepareAgentReview': {
        if (user.role !== 'admin')
          return c.json(
            { error: '模型复核工作区需要管理员配置宿主机执行环境' },
            403,
          );
        const detail = service.getCase(field(p.caseId, 'caseId'));
        const plan = service.getContextPlan(detail.id, 6000);
        if (plan.action === 'manual_review')
          return c.json(
            { error: '当前最小调查上下文超出预算，请先人工分段复核' },
            400,
          );
        const prompt =
          '请复核以下 FarmGuard 调查证据。使用案件工具核对事实，结论引用证据编号；保留未解决问题，不将环境相关性当作死亡原因。' +
          (plan.action === 'split'
            ? '\n本次仅处理计划指定的当前节点，其余方向按待办继续。\n'
            : '\n') +
          plan.blocks.map((block) => block.content).join('\n\n');
        const linkDir = path.join(
          DATA_DIR,
          'farmguard',
          'agent-links',
          user.id,
        );
        fs.mkdirSync(linkDir, { recursive: true });
        const linkFile = path.join(linkDir, detail.id + '.json');
        if (fs.existsSync(linkFile)) {
          const saved = JSON.parse(fs.readFileSync(linkFile, 'utf8')) as {
            jid: string;
            folder: string;
          };
          const group = getRegisteredGroup(saved.jid);
          if (group?.created_by === user.id)
            return c.json({ ...saved, prompt, contextAction: plan.action });
        }
        const cookie = c.req.header('cookie') ?? '';
        const mcpId = 'farmguard-' + detail.id;
        await invokeNative(
          '/api/mcp-servers',
          {
            id: mcpId,
            command: process.execPath,
            args: [path.join(process.cwd(), 'dist', 'farmguard', 'mcp.js')],
            scope: 'user',
            description: 'FarmGuard 案件范围绑定的调查、证据与记忆工具',
            env: {
              FARMGUARD_DATA_DIR: path.join(
                DATA_DIR,
                'farmguard',
                'users',
                user.id,
              ),
              FARMGUARD_CASE_ID: detail.id,
            },
          },
          cookie,
        );
        const profile = await invokeNative(
          '/api/agent-profiles',
          {
            name: ('FarmGuard · ' + detail.title).slice(0, 80),
            prompt_schema_version: 2,
            prompt_mode: 'replace',
            identity_prompt:
              '你是 FarmGuard 合规调查助手，处理当前案件的死亡率、环境、库存用药与防疫证据。',
            soul_prompt:
              '依据证据判断，保留不确定性，重要调查结论由执行人员确认。',
            agents_prompt: `当前案件：${detail.id}。先读取案件、规则与报告，再按证据编号复核；不要修改证据或自行确认报告。`,
            tools_prompt: `使用 ${mcpId} 的案件工具。调用工具前明确猪舍、批次和时间窗，历史事实与当前处置决策分开使用。`,
            avatar_emoji: '🌿',
            avatar_color: '#205641',
            runtime_policy: {
              context: { source: 'managed' },
              skills: {
                mode: 'disabled',
                ids: [],
                host: { mode: 'disabled', ids: [] },
              },
              mcp: { mode: 'custom', ids: ['user:' + mcpId] },
            },
          },
          cookie,
        );
        const created = await invokeNative(
          '/api/groups',
          {
            name: ('FarmGuard · ' + detail.title).slice(0, 60),
            agent_profile_id: profile.profile.id,
            execution_mode: 'host',
          },
          cookie,
        );
        const saved = {
          jid: String(created.jid),
          folder: String(created.group.folder),
          profileId: String(profile.profile.id),
          mcpId,
        };
        const temporary = linkFile + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(saved, null, 2), {
          encoding: 'utf8',
          mode: 0o600,
        });
        fs.renameSync(temporary, linkFile);
        return c.json({ ...saved, prompt, contextAction: plan.action });
      }
      case 'seedDemoCases':
        return c.json(service.seedDemoCases());
      case 'createCase': {
        if (p.scenario !== undefined && !scenarios.has(String(p.scenario)))
          throw new Error('未知调查场景');
        return c.json(
          service.createCase({
            title: optionalText(p.title),
            farmId: optionalText(p.farmId),
            barnId: optionalText(p.barnId),
            batchId: optionalText(p.batchId),
            startDate: optionalText(p.startDate),
            endDate: optionalText(p.endDate),
            scenario: p.scenario as ScenarioId | undefined,
          }),
        );
      }
      case 'startInvestigation':
        return c.json(service.startInvestigation(field(p.caseId, 'caseId')));
      case 'confirmReport':
        if (p.decision !== 'confirmed' && p.decision !== 'needs_review')
          throw new Error('未知复核决定');
        return c.json(
          service.confirmReport(field(p.caseId, 'caseId'), {
            decision: p.decision,
            note: field(p.note, '复核说明'),
            actor: user.display_name || user.username,
          }),
        );
      case 'queryMemory': {
        if (p.kind !== undefined && !memoryKinds.has(String(p.kind)))
          throw new Error('未知记忆类型');
        return c.json(
          service.queryMemory({
            query: optionalText(p.query) ?? '',
            farmId: optionalText(p.farmId),
            batchId: optionalText(p.batchId),
            startDate: optionalText(p.startDate),
            endDate: optionalText(p.endDate),
            ruleVersion: optionalText(p.ruleVersion),
            kind: p.kind as MemoryKind | undefined,
            historicalFacts: p.historicalFacts === true,
            limit: typeof p.limit === 'number' ? p.limit : undefined,
          }),
        );
      }
      case 'exportTrace':
        return c.json(service.exportTrace(field(p.caseId, 'caseId')));
      default:
        return c.json({ error: '未知业务操作' }, 400);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '操作失败';
    return c.json(
      { error: message },
      /不存在|not found/i.test(message) ? 404 : 400,
    );
  }
});

routes.get('/events', (c) => {
  const user = c.get('user') as AuthUser;
  serviceFor(user.id);
  c.header('Content-Encoding', 'identity');
  return streamSSE(c, async (stream) => {
    let active = true;
    let queue: Promise<unknown> = Promise.resolve();
    const listeners =
      subscribers.get(user.id) ?? new Set<(event: FarmGuardEvent) => void>();
    subscribers.set(user.id, listeners);
    const listener = (event: FarmGuardEvent) => {
      queue = queue
        .then(() => stream.writeSSE({ data: JSON.stringify(event) }))
        .catch(() => {
          active = false;
        });
    };
    listeners.add(listener);
    stream.onAbort(() => {
      active = false;
      listeners.delete(listener);
    });
    try {
      await stream.writeSSE({ data: JSON.stringify({ type: 'connected' }) });
      while (active) {
        await stream.sleep(15000);
        if (active) await stream.writeSSE({ event: 'heartbeat', data: '{}' });
      }
    } finally {
      listeners.delete(listener);
    }
  });
});

export default routes;
