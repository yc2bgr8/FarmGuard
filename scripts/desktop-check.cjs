const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium, request } = require('../app/web/node_modules/playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9229');
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().startsWith('http://127.0.0.1:3111'));
  assert(page, 'FarmGuard desktop page missing');
  const phase = process.argv[2] || 'inspect';
  const credentialFile = path.join(root, '.profile', 'local-account.json');
  const outputDir = path.join(root, 'validation');
  fs.mkdirSync(outputDir, { recursive: true });
  await page.bringToFront();
  const screenshot = async name => {
    const session = await context.newCDPSession(page);
    const result = await Promise.race([
      session.send('Page.captureScreenshot', { format: 'png', fromSurface: false, captureBeyondViewport: false }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Desktop screenshot timed out')), 10000)),
    ]);
    fs.writeFileSync(path.join(outputDir, name), Buffer.from(result.data, 'base64'));
    await session.detach();
  };
  const call = async (action, payload = {}) => {
    const response = await context.request.post('http://127.0.0.1:3111/api/farmguard/call', { data: { action, payload } });
    const data = await response.json();
    assert(response.ok(), `${action}: ${JSON.stringify(data)}`);
    return data;
  };
  if (phase === 'setup') {
    if (new URL(page.url()).pathname === '/setup') {
      const account = { username: 'farmguard_demo', password: crypto.randomBytes(20).toString('base64url') };
      fs.writeFileSync(credentialFile, JSON.stringify(account), { mode: 0o600 });
      await page.getByPlaceholder('3-32 位字母、数字或下划线').fill(account.username);
      await page.getByPlaceholder('至少 8 位').fill(account.password);
      await page.getByPlaceholder('再次输入密码').fill(account.password);
      await page.getByRole('button', { name: /创建账号并/ }).click();
      await page.waitForURL('**/farmguard');
    }
    await page.getByRole('heading', { name: '风险调查工作台' }).waitFor();
    console.log('Desktop account initialized and FarmGuard workbench reached.');
  }
  if (phase === 'investigate') {
    const cases = await call('listCases');
    assert.equal(cases.length, 5);
    await page.evaluate(() => {
      window.farmguardCheckEvents = [];
      window.farmguardCheckSource = new EventSource('/api/farmguard/events');
      window.farmguardCheckSource.onmessage = e => window.farmguardCheckEvents.push(JSON.parse(e.data));
    });
    const results = [];
    for (const item of cases) {
      await page.getByRole('button', { name: new RegExp(item.title) }).click();
      await page.getByRole('heading', { name: item.title, exact: true }).waitFor();
      const responsePromise = page.waitForResponse(async response => {
        if (!response.url().endsWith('/api/farmguard/call')) return false;
        try { return response.request().postDataJSON().action === 'startInvestigation'; } catch { return false; }
      });
      await page.getByRole('button', { name: /^(启动调查|重新调查)$/ }).click();
      const response = await responsePromise;
      const ticket = await response.json();
      assert(response.ok());
      assert.equal(ticket.status, 'queued');
      assert(ticket.taskId);
      await page.waitForFunction(taskId => window.farmguardCheckEvents.some(e => e.type === 'task_complete' && e.taskId === taskId), ticket.taskId);
      const detail = await call('getCase', { caseId: item.id });
      assert.equal(detail.tasks[0].id, ticket.taskId);
      assert.equal(detail.tasks[0].status, 'completed');
      assert.equal(detail.report.taskId, ticket.taskId);
      assert.equal(detail.evidence.length, item.scenario === 'normal' ? 1 : 4);
      assert.equal(detail.report.status, item.scenario === 'normal' ? 'normal' : item.scenario === 'ambiguous' ? 'needs_review' : 'risk');
      assert(detail.report.evidenceIds.every(id => detail.evidence.some(e => e.id === id)));
      results.push({ caseId: item.id, scenario: item.scenario, ticket, evidenceCount: detail.evidence.length, reportStatus: detail.report.status });
    }
    await page.evaluate(() => window.farmguardCheckSource.close());
    fs.writeFileSync(path.join(outputDir, 'desktop-results.json'), JSON.stringify(results, null, 2));
    const environment = cases.find(c => c.scenario === 'environment_no_alert');
    await page.getByRole('button', { name: new RegExp(environment.title) }).click();
    await page.getByRole('button', { name: '调查概览', exact: true }).click();
    await page.locator('.fg-environment-chart svg').waitFor();
    console.log('All five desktop investigations completed; matching SSE events, tickets, evidence and report references verified.');
  }
  if (phase === 'review') {
    const cases = await call('listCases');
    const environment = cases.find(c => c.scenario === 'environment_no_alert');
    await page.getByRole('button', { name: new RegExp(environment.title) }).click();
    await page.getByRole('button', { name: '原始证据', exact: true }).click();
    const evidenceDialog = page.getByRole('dialog');
    await evidenceDialog.getByText('工具返回原始数据', { exact: true }).waitFor();
    assert.equal((await evidenceDialog.locator('.fg-hash').innerText()).length, 64);
    await screenshot('desktop-evidence.png');
    await evidenceDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '核查报告', exact: true }).click();
    await page.getByRole('button', { name: '人工确认', exact: true }).click();
    await page.getByPlaceholder('记录核实依据、未解决问题或下一步安排').fill('桌面演示验证：已核对四类合成证据与引用；确认调查记录，保留死亡原因需人工核实的结论。');
    await page.getByRole('button', { name: '保存确认', exact: true }).click();
    await page.getByText('报告已确认，复核记录已保存。', { exact: true }).waitFor();
    const confirmed = await call('getCase', { caseId: environment.id });
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.report.confirmed, true);
    assert(confirmed.report.confirmation.actor);
    fs.writeFileSync(path.join(outputDir, 'persisted-report.json'), JSON.stringify({ caseId: environment.id, taskId: confirmed.report.taskId, reportId: confirmed.report.id, confirmation: confirmed.report.confirmation, hashes: confirmed.evidence.map(e => e.snapshotHash) }, null, 2));
    await screenshot('desktop-report.png');
    const conflict = cases.find(c => c.scenario === 'ambiguous');
    await page.getByRole('button', { name: new RegExp(conflict.title) }).click();
    await page.getByRole('heading', { name: conflict.title, exact: true }).waitFor();
    await page.getByRole('button', { name: '核查报告', exact: true }).click();
    await page.getByRole('button', { name: '人工确认', exact: true }).click();
    assert.equal(await page.getByRole('dialog').locator('select').inputValue(), 'needs_review');
    assert.notEqual(await page.getByRole('dialog').locator('option[value="confirmed"]').getAttribute('disabled'), null);
    await page.getByRole('button', { name: '关闭人工确认' }).click();
    console.log('Evidence snapshots, report confirmation and conflict confirmation guard verified through desktop controls.');
  }
  if (phase === 'conflict') {
    await page.goto('http://127.0.0.1:3111/farmguard');
    const cases = await call('listCases');
    const conflict = cases.find(c => c.scenario === 'ambiguous');
    await page.getByRole('button', { name: new RegExp(conflict.title) }).click();
    await page.getByRole('heading', { name: conflict.title, exact: true }).waitFor();
    await page.getByRole('button', { name: '核查报告', exact: true }).click();
    await page.getByRole('button', { name: '人工确认', exact: true }).click();
    assert.equal(await page.getByRole('dialog').locator('select').inputValue(), 'needs_review');
    assert.notEqual(await page.getByRole('dialog').locator('option[value="confirmed"]').getAttribute('disabled'), null);
    await page.getByRole('button', { name: '关闭人工确认' }).click();
    console.log('Conflicting report cannot be confirmed through the desktop control.');
  }
  if (phase === 'agent') {
    const cases = await call('listCases');
    const item = cases.find(c => c.scenario === 'environment_no_alert');
    const prepared = await call('prepareAgentReview', { caseId: item.id });
    assert(prepared.jid && prepared.folder && prepared.profileId && prepared.mcpId);
    assert(prepared.prompt.includes(item.id));
    const second = await call('prepareAgentReview', { caseId: item.id });
    assert.equal(prepared.jid, second.jid);
    fs.writeFileSync(path.join(outputDir, 'agent-setup.json'), JSON.stringify({ jid: prepared.jid, folder: prepared.folder, profileId: prepared.profileId, mcpId: prepared.mcpId, contextAction: prepared.contextAction }, null, 2));
    await page.getByRole('button', { name: new RegExp(item.title) }).click();
    await page.getByRole('button', { name: 'Agent 工作区', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/chat/' + prepared.folder);
    await page.waitForFunction(caseId => Array.from(document.querySelectorAll('textarea')).some(el => el.value.includes(caseId)), item.id);
    console.log('Case-pinned MCP, Agent profile and workspace created; repeated preparation reuses the same workspace. Desktop route: ' + new URL(page.url()).pathname);
  }
  if (phase === 'persistence') {
    const expected = JSON.parse(fs.readFileSync(path.join(outputDir, 'persisted-report.json'), 'utf8'));
    const detail = await call('getCase', { caseId: expected.caseId });
    assert.equal(detail.report.id, expected.reportId);
    assert.equal(detail.report.taskId, expected.taskId);
    assert.deepEqual(detail.report.confirmation, expected.confirmation);
    assert.deepEqual(detail.evidence.map(e => e.snapshotHash), expected.hashes);
    assert.equal(detail.status, 'confirmed');
    const unauthenticated = await request.newContext();
    const response = await unauthenticated.post('http://127.0.0.1:3111/api/farmguard/call', { data: { action: 'listCases' } });
    assert.equal(response.status(), 401);
    await unauthenticated.dispose();
    await page.goto('http://127.0.0.1:3111/farmguard');
    await page.getByRole('heading', { name: detail.title, exact: true }).waitFor();
    await page.getByRole('button', { name: '核查报告', exact: true }).click();
    await page.getByText('报告已人工确认', { exact: true }).waitFor();
    console.log('Backend/desktop restart preserved the report, confirmation, task and all four evidence hashes.');
  }
  if (phase === 'policy') {
    const setup = JSON.parse(fs.readFileSync(path.join(outputDir, 'agent-setup.json'), 'utf8'));
    const response = await context.request.get('http://127.0.0.1:3111/api/agent-profiles');
    assert(response.ok());
    const profiles = (await response.json()).profiles;
    const profile = profiles.find(p => p.id === setup.profileId);
    assert(profile);
    assert.equal(profile.prompt_mode, 'replace');
    assert.equal(profile.runtime_policy.mcp.mode, 'custom');
    assert.deepEqual(profile.runtime_policy.mcp.ids, ['user:' + setup.mcpId]);
    assert.equal(profile.runtime_policy.skills.mode, 'disabled');
    assert.equal(profile.runtime_policy.skills.host.mode, 'disabled');
    assert(profiles.find(p => p.is_default).name === 'FarmGuard');
    const disabledFeedback = await context.request.post('http://127.0.0.1:3111/api/bug-report/submit', { data: { title: 'local check', body: 'local check' } });
    assert.equal(disabledFeedback.status(), 400);
    console.log('Native profile persisted the case MCP selection and prompt policy; default branding and unconfigured feedback guard verified.');
  }
  if (phase === 'final') {
    await page.goto('http://127.0.0.1:3111/farmguard');
    await page.getByRole('heading', { name: '环境恶化未报警', exact: true }).waitFor();
    await page.getByRole('button', { name: '调查概览', exact: true }).click();
    await page.locator('.fg-environment-chart svg').waitFor();
    await page.getByRole('heading', { name: 'SOP 调查进度', exact: true }).scrollIntoViewIfNeeded();
    console.log('FarmGuard desktop left open on the verified investigation overview.');
  }
  if (phase === 'memory-context') {
    await page.goto('http://127.0.0.1:3111/farmguard');
    const cases = await call('listCases');
    const item = cases.find(c => c.scenario === 'environment_no_alert');
    await page.getByRole('button', { name: new RegExp(item.title) }).click();
    await page.getByRole('heading', { name: item.title, exact: true }).waitFor();
    await page.getByRole('button', { name: '上下文', exact: true }).click();
    await page.getByText('预算内可执行', { exact: true }).waitFor();
    const plans = [];
    for (const budgetChars of [6000, 1500, 500]) {
      const plan = await call('getContextPlan', { caseId: item.id, budgetChars });
      assert.equal(plan.preservedEvidenceIds.length, 4);
      assert(plan.blocks.some(b => b.role === 'scope'));
      assert(plan.blocks.some(b => b.role === 'plan'));
      plans.push({ budgetChars, action: plan.action, totalChars: plan.totalChars });
    }
    assert(plans.some(p => p.action === 'manual_review'));
    const budget = page.locator('.fg-context-budget input');
    if (await budget.count()) {
      await budget.fill('500');
      await page.getByText('最小上下文仍超限', { exact: true }).waitFor();
      await screenshot('desktop-context-blocked.png');
      await budget.fill('6000');
    }
    await page.getByRole('button', { name: '结构化记忆', exact: true }).click();
    await page.getByPlaceholder('输入关键词，例如：环境、死亡、库存、防疫').fill('环境');
    await page.getByRole('button', { name: '检索记忆', exact: true }).click();
    await page.locator('.fg-memory-card').first().waitFor();
    const memory = await call('queryMemory', { query: '环境', farmId: item.farmId, batchId: item.batchId, ruleVersion: item.ruleVersion });
    assert(memory.length > 0 && memory.every(m => m.ruleVersion === item.ruleVersion));
    await screenshot('desktop-memory.png');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '检索记忆', exact: true }).click();
    const history = await call('queryMemory', { query: '环境', historicalFacts: true });
    assert(history.every(m => m.kind === 'fact' && m.historical === true));
    fs.writeFileSync(path.join(outputDir, 'context-results.json'), JSON.stringify(plans, null, 2));
    console.log('Memory search, applicable rule versions, historical fact separation and context budgeting verified.');
  }
  if (phase !== 'policy') {
    console.log(await page.locator('body').innerText());
    await screenshot('desktop-' + phase + '.png').catch(error => console.log('Screenshot skipped: ' + error.message));
  }
  await browser.close();
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
