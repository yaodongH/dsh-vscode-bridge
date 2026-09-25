// dsh-vscode-bridge 0.1.20 e2e：实例池 + 弹窗会话标题（隔离调试实例 3190）
import { chromium } from '@playwright/test';
import fs from 'node:fs';
// 用法：DSH_URL='http://127.0.0.1:3190/?token=<token>' node demo/e2e-instance-pool.mjs

const TOKEN_URL = process.env.DSH_URL || 'http://127.0.0.1:3190/?token=<一次性启动 token>';
const OUT = '/home/huangyaodong/deepseek-harness-workspace/vscode-bridge/demo';
fs.mkdirSync(OUT, { recursive: true });

const TITLES = {
  A: '重构实例池弹窗与会话标题展示',
  B: 'API工作流事件管理进展与后续工作',
  C: 'CMDB-Ops sayhi命令历史记录去重优化方案设计',
};
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.emulateMedia({ colorScheme: 'dark' });

let navCount = 0;
page.on('framenavigated', (f) => { if (/:18654/.test(f.url())) navCount += 1; });

const frames = () => page.evaluate(() => Array.from(document.querySelectorAll('iframe[title="VS Code"]')).map((f) => decodeURIComponent(f.getAttribute('src') || '').replace(/^.*18654/, '')));
const modalInfo = () => page.evaluate(() => {
  const m = document.querySelector('[data-dshvs-modal="evict"]');
  if (!m) return null;
  return {
    target: m.dataset.target,
    options: Array.from(m.querySelectorAll('.dshvs-opt')).map((o) => (o.textContent || '').trim().replace(/\s+/g, ' ')),
    desc: (m.querySelector('.dshvs-kv') || {}).textContent,
  };
});
const vis = (sel) => page.locator(sel).first().isVisible().catch(() => false);
const dismissModals = async () => {
  for (let i = 0; i < 3; i++) {
    let clicked = false;
    for (const label of ['Configure later', 'Continue']) {
      const b = page.getByRole('button', { name: label, exact: true });
      if (await b.count() && await b.first().isVisible().catch(() => false)) {
        await b.first().click().catch(() => {});
        clicked = true;
        await page.waitForTimeout(900);
      }
    }
    if (!clicked) return;
  }
};
const openVscodeTab = async (waitMs = 3500) => {
  await dismissModals();
  if (await vis('.dshvs-stage')) return;
  if (!(await vis('[data-dockkit-add-tab]'))) {
    const e = page.locator('[data-sidebar-right-expand]').first();
    if (await e.count()) { await e.click().catch(() => {}); await page.waitForTimeout(900); }
  }
  if (!(await vis('[data-sidebar-right-guide]'))) {
    const a = page.locator('[data-dockkit-add-tab]').first();
    if (await a.isVisible().catch(() => false)) { await a.click(); await page.waitForTimeout(900); }
  }
  for (let i = 0; i < 4; i++) {
    const en = page.locator('[data-sidebar-right-guide-entry="dsh-vscode-bridge:ide"]');
    if (await en.count()) await en.first().click().catch(() => {});
    await page.waitForTimeout(waitMs);
    if (await vis('.dshvs-stage')) return;
    const add = page.locator('[data-dockkit-add-tab]').first();
    if (await add.isVisible().catch(() => false)) await add.click().catch(() => {});
    await page.waitForTimeout(800);
  }
};
const clickSessionByTitle = async (title, ws) => {
  // 防御：上一步残留的腾位弹窗会挡住会话行点击，先取消
  const m = page.locator('[data-dshvs-modal="evict"]');
  if (await m.count()) {
    const c = page.getByRole('button', { name: '取消', exact: true });
    if (await c.count()) await c.first().click().catch(() => {});
    await page.waitForTimeout(800);
  }
  const sec = page.locator('div.SU90lW_groupSection').filter({ has: page.locator('._2owDTq_projectRow', { hasText: ws }) }).first();
  let rows = sec.locator('._2owDTq_sessionRow').filter({ hasText: title });
  if (await rows.count() === 0) {
    await sec.locator('._2owDTq_projectRow').first().click();
    await page.waitForTimeout(1200);
    rows = sec.locator('._2owDTq_sessionRow').filter({ hasText: title });
  }
  const rowKey = await rows.first().getAttribute('data-row-key');
  console.log('  [switch] title=' + title + ' rows=' + await rows.count() + ' key=' + rowKey);
  const sid = String(rowKey || '').replace(/^session:/, '');
  for (let i = 0; i < 8; i++) {
    await rows.first().click().catch(() => {});
    await page.waitForTimeout(1200);
    await dismissModals();
    const shown = await page.evaluate((t) => {
      const main = document.querySelector('[data-slot="main"]');
      return !!main && (main.textContent || '').includes(t);
    }, title);
    if (shown) {
      await page.waitForTimeout(1800); // 等 uiSession 适配层/订阅跟进
      const after = await page.evaluate(() => {
        let cur = null; try { cur = JSON.parse(localStorage.getItem('dsh.sessions.current') || 'null'); } catch (e) {}
        const bar = (document.querySelector('.dshvs-bar') || {}).textContent || '';
        return { cur: cur && cur.sessionId, bar: bar.trim().replace(/\s+/g, ' ').slice(0, 50) };
      });
      console.log('  [switch ok] ' + title + ' clicked=' + rowKey + ' now=' + JSON.stringify(after));
      return;
    }
    console.log('  [switch retry] ' + title + ' mainShows=' + shown);
  }
  throw new Error('session switch failed: ' + title);
};
const shot = async (name) => {
  await dismissModals();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const bar = await page.evaluate(() => (document.querySelector('.dshvs-bar') || {}).textContent || '');
  const mi = await modalInfo();
  console.log('  [shot] ' + name + ' | bar=' + bar.trim().replace(/\s+/g, ' ').slice(0, 80) + (mi ? ' | modal target=' + mi.target : ''));
};

// ─── 1. 打开 VS Code（空间 A）───
await page.goto(TOKEN_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
// 首次启动公告（隔离实例仅出现一次）
await dismissModals();
await clickSessionByTitle(TITLES.A, 'deepseek-harness-workspace');
await openVscodeTab(2500);
for (let i = 0; i < 20 && (await frames()).length === 0; i++) await page.waitForTimeout(1500);
let f = await frames();
check('1. 打开 VS Code 产生 1 个实例', f.length === 1, 'frames=' + f.length);
check('1. 实例 folder = 会话 A 所在空间', f.length === 1 && f[0].includes('deepseek-harness-workspace'), f[0] || '');
await shot('01-instance-a');

// ─── 2. 切到空间 B → 自动新建第 2 实例（池未满不弹窗）───
navCount = 0;
await clickSessionByTitle(TITLES.B, 'api-management-workspace');
await openVscodeTab();
f = await frames();
let mi = await modalInfo();
check('2. 跨空间自动新建实例', f.length === 2, 'frames=' + f.length);
check('2. 池未满不弹窗', mi === null, JSON.stringify(mi));
await shot('02-instance-b');

// ─── 3. 切回空间 A → 池内秒切（零重载）───
navCount = 0;
await clickSessionByTitle(TITLES.A, 'deepseek-harness-workspace');
await openVscodeTab();
f = await frames();
check('3. 切回原空间实例数不变', f.length === 2, 'frames=' + f.length);
check('3. 池内秒切零重载', navCount <= 1, 'navs=' + navCount);
await shot('03-warm-swap-a');

// ─── 4. 切到空间 C → 池满弹窗（带会话标题）───
navCount = 0;
await clickSessionByTitle(TITLES.C, 'cmdb-ops');
await openVscodeTab();
mi = await modalInfo();
check('4. 池满弹窗出现', mi !== null, JSON.stringify(mi));
check('4. 弹窗列出 2 个可腾位实例', mi && mi.options.length === 2, 'options=' + (mi && mi.options.length));
check('4. 候选含空间 A 的会话标题', !!mi && mi.options.join(' ').includes(TITLES.A), mi ? mi.options.join(' | ') : '');
check('4. 候选含空间 B 的会话标题', !!mi && mi.options.join(' ').includes(TITLES.B), '');
check('4. 描述行含触发会话标题', !!mi && String(mi.desc).includes(TITLES.C), mi ? String(mi.desc).slice(0, 120) : '');
await shot('04-evict-dialog');

// ─── 5. 取消 → 保持现状（状态条提示）───
const cancel = page.getByRole('button', { name: '取消' });
if (await cancel.count()) await cancel.first().click();
await page.waitForTimeout(1500);
f = await frames();
mi = await modalInfo();
const barText = await page.evaluate(() => (document.querySelector('.dshvs-bar') || {}).textContent || '');
check('5. 取消后实例数不变', f.length === 2, 'frames=' + f.length);
check('5. 取消后弹窗关闭', mi === null, JSON.stringify(mi));
check('5. 状态条提示未跟随', barText.includes('实例池已满'), barText.slice(0, 120));
await shot('05-cancelled');

// ─── 6. 切走再切回 → 重弹 → 踢出所选并打开 ───
navCount = 0;
await clickSessionByTitle(TITLES.B, 'api-management-workspace');
await openVscodeTab();
await clickSessionByTitle(TITLES.C, 'cmdb-ops');
await openVscodeTab();
mi = await modalInfo();
check('6. 切回后重新弹窗', mi !== null, JSON.stringify(mi));
const confirm = page.getByRole('button', { name: '踢出所选并打开' });
if (await confirm.count()) await confirm.first().click();
await page.waitForTimeout(4500);
f = await frames();
check('6. 腾位后实例数恒为上限', f.length === 2, 'frames=' + f.length);
check('6. 新空间实例已建立', f.some((s) => s.includes('cmdb-ops')), JSON.stringify(f.map((s) => s.slice(0, 46))));
await shot('06-evicted-opened');

// ─── 7. 设置页「实例池上限」───
const settingsBtn = page.getByText('Settings', { exact: false }).first();
if (await settingsBtn.count()) {
  await settingsBtn.click();
  await page.waitForTimeout(1500);
  const section = page.getByText('VS Code Server', { exact: false }).first();
  if (await section.count()) { await section.click(); await page.waitForTimeout(1500); }
  const hasField = await page.getByText('实例池上限', { exact: false }).count();
  check('7. 设置页含「实例池上限」字段', hasField > 0, 'count=' + hasField);
  await shot('07-settings-pool');
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log('\n=== SUMMARY: ' + (results.length - failed.length) + '/' + results.length + ' passed ===');
for (const r of failed) console.log('  FAIL: ' + r.name + ' :: ' + r.detail);
fs.writeFileSync(`${OUT}/e2e-results-0.1.20.json`, JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
