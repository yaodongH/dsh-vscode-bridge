// dsh-vscode-bridge 0.1.21 e2e：专注布局（新开的 VS Code 默认只显示 Codex）
// 隔离调试实例 3190（DSH_HOME=/tmp/dsh-dev-home，DSH_VSCODE_BRIDGE_WORKSPACE=/tmp/dsh-dev-ws，
// code-server 落 18654）。按工作空间规则 1，全程未触碰 3080 主实例。
// 用法：DSH_URL='http://127.0.0.1:3190/?token=<token>' node demo/e2e-focus-layout.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const TOKEN_URL = process.env.DSH_URL || 'http://127.0.0.1:3190/?token=<一次性启动 token>';
const OUT = '/home/huangyaodong/deepseek-harness-workspace/vscode-bridge/demo';
const SETTINGS = '/tmp/dsh-dev-ws/.dsh/vscode-bridge/data/user-data/User/settings.json';
fs.mkdirSync(OUT, { recursive: true });

const TITLES = {
  alpha: '专注布局 Alpha 首开验证',
  beta: '专注布局 Beta 全新空间验证',
  gamma: '专注布局 Gamma 关闭开关验证',
  delta: '专注布局 Delta 重新开启验证',
};
// 切换到某空间：hover 项目行 → 点「New session in <空间>」（创建并选中该空间的会话，
// 当前空间随之切换）。行选中态与文案在不同构建间不稳定，最终以 VS Code iframe 的
// ?folder= 是否指向该空间目录为准（这正是 folder-follow 的真实信号）。
const clickSessionByTitle = async (_title, ws) => {
  // 防御：残留遮罩/腾位弹窗会挡住交互，先清掉
  if (await page.locator('[class*="_mask"]').first().isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(900);
  }
  const m = page.locator('[data-dshvs-modal="evict"]');
  if (await m.count()) {
    const c = page.getByRole('button', { name: '取消', exact: true });
    if (await c.count()) await c.first().click().catch(() => {});
    await page.waitForTimeout(800);
  }
  const prow = page.locator('._2owDTq_projectRow[data-row-key^="workspace:"]').filter({ hasText: ws }).first();
  for (let i = 0; i < 6; i++) {
    if (!(await prow.isVisible().catch(() => false))) { await page.waitForTimeout(800); continue; }
    await prow.scrollIntoViewIfNeeded().catch(() => {});
    await prow.hover();
    await page.waitForTimeout(350);
    const btn = page.getByRole('button', { name: 'New session in ' + ws });
    if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(2500); console.log('  [switch] new session in ' + ws); return; }
    console.log('  [switch retry] no "New session in ' + ws + '" button yet');
  }
  throw new Error('space switch failed: ' + ws);
};
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
};

// ─── 重置到干净基线：停 code-server → 清 user-data（回到「全部 workspace 首次打开」）
//     → config 复位（focusLayout=true、池上限 8）→ ensure 启动。e2e 可重复执行的前提。
const API = 'http://127.0.0.1:3190';
const CFG = '/tmp/dsh-dev-ws/.dsh/vscode-bridge/config.json';
const jpost = async (path, body) => {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json().catch(() => ({}));
};
try {
  await jpost('/dsh-vscode/control', { action: 'stop' });
  await new Promise((r) => setTimeout(r, 4000));
  fs.rmSync('/tmp/dsh-dev-ws/.dsh/vscode-bridge/data/user-data', { recursive: true, force: true });
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  cfg.focusLayout = true;
  cfg.instancePoolSize = 8;
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n');
  await jpost('/dsh-vscode/control', { action: 'ensure' });
  await new Promise((r) => setTimeout(r, 8000));
  console.log('[reset] done: config focusLayout=true, pool=8, user-data wiped');
} catch (e) {
  console.log('[reset] skipped: ' + String(e).slice(0, 160));
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.emulateMedia({ colorScheme: 'dark' });

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
const srcList = () => page.evaluate(() => Array.from(document.querySelectorAll('iframe[title="VS Code"]')).map((f) => decodeURIComponent(f.getAttribute('src') || '')));
const openVscodeTab = async (waitMs = 3500) => {
  await dismissModals();
  if (await vis('.dshvs-stage')) return;
  if (!(await vis('[data-sidebar-right-guide]'))) {
    // 右栏折叠时先点展开钮，右侧栏 guide（含 VS Code 页签入口）才会出现
    const e = page.locator('[data-sidebar-right-expand]').first();
    if (await e.count()) { await e.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(900); }
  }
  if (!(await vis('[data-sidebar-right-guide]'))) {
    const a = page.locator('[data-dockkit-add-tab]').first();
    if (await a.isVisible().catch(() => false)) { await a.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(900); }
  }
  for (let i = 0; i < 4; i++) {
    const en = page.locator('[data-sidebar-right-guide-entry="dsh-vscode-bridge:ide"]');
    if (await en.count()) await en.first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(waitMs);
    if (await vis('.dshvs-stage')) return;
    const add = page.locator('[data-dockkit-add-tab]').first();
    if (await add.isVisible().catch(() => false)) await add.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
};
// 等待某个 folder 的 workbench 就绪（跨 frame 冷启动/重载后重新解析 Frame 对象）
const waitVsFrame = async (dir, tag = '', timeoutMs = 90000) => {
  const t0 = Date.now();
  for (;;) {
    const f = page.frames().find((x) => /:18654/.test(x.url()) && decodeURIComponent(x.url()).includes(dir) && (!tag || x.url().includes(tag)));
    if (f) {
      try { await f.waitForSelector('.part.activitybar, .part.auxiliarybar, .part.editor', { timeout: 8000 }); return f; } catch (e) { /* 未就绪，继续等 */ }
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('frame not ready: ' + dir + (tag ? ' tag=' + tag : ''));
    await page.waitForTimeout(1000);
  }
};
// workbench 布局探针：根容器类名 + 各 part 实测几何（跨域 frame 内 evaluate，Playwright 经 CDP 直达）
const layoutOf = async (f) => await f.evaluate(() => {
  const roots = [document.body, document.querySelector('.main-container'), document.querySelector('.monaco-workbench')].filter(Boolean);
  const tokens = new Set();
  for (const r of roots) for (const t of String(r.getAttribute('class') || '').split(/\s+/)) if (t) tokens.add(t);
  const has = (c) => tokens.has(c);
  const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  // workbench 根容器实测几何（bridge 内嵌时只占宿主右栏区域，不代表整个视口）
  const wbel = document.querySelector('.main-container') || document.querySelector('.monaco-workbench') || document.body;
  const wbr = wbel.getBoundingClientRect();
  return {
    wb: { w: Math.round(wbr.width), h: Math.round(wbr.height) },
    nosidebar: has('nosidebar'), nomaineditorarea: has('nomaineditorarea'), nopanel: has('nopanel'),
    noauxiliarybar: has('noauxiliarybar'), noactivitybar: has('noactivitybar'), nostatusbar: has('nostatusbar'),
    aux: rect('.part.auxiliarybar'), sidebar: rect('.part.sidebar'), editor: rect('.part.editor'),
    panel: rect('.part.panel'), statusbar: rect('.part.statusbar'), activitybar: rect('.part.activitybar'),
  };
});
// 最大化判定以 workbench 实宽为准：副边栏宽度 ≈ workbench 宽 − 活动栏宽
const focusedShape = (l) => l.nosidebar && l.nomaineditorarea && l.nopanel && !l.noauxiliarybar && !l.noactivitybar
  && l.aux && l.wb && l.aux.w >= l.wb.w - (l.activitybar ? l.activitybar.w : 0) - 30;
const normalShape = (l) => !l.nosidebar && !l.nomaineditorarea && l.sidebar && l.sidebar.w > 50 && l.editor && l.editor.w > 50;
const shot = async (name) => {
  await dismissModals();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const srcs = await srcList();
  console.log('  [shot] ' + name + ' | frames=' + srcs.length + ' | ' + srcs.map((s) => s.replace(/^.*?folder=/, '').slice(0, 60)).join(' ; '));
};
const settingsJson = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { return {}; } };
const settingsKeys = (sj) => ['workbench.secondarySideBar.defaultVisibility', 'workbench.statusBar.visible', 'workbench.startupEditor'].map((k) => k + '=' + JSON.stringify(sj[k])).join(' ');
// 专注开关：统一走 API（与多页签他端改配置完全等价：客户端经 1.5s 轮询差值发现 → 推送 → 收敛重载）。
// 设置页勾选框的真实性单独在 V6 做 UI 检查（只读 + 截图，不做写入，避免误触「重启 code-server」）。
const toggleFocus = async (on) => {
  await page.evaluate(async (v) => {
    await fetch('/dsh-vscode/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { focusLayout: v } }) });
  }, on);
  return 'api';
};
// 桥自身的重载机制（等价 convergeLayout）：bump iframe src 的 dshreload 参数
const reloadFrame = async (dir) => {
  await page.evaluate((d) => {
    const f = Array.from(document.querySelectorAll('iframe[title="VS Code"]')).find((x) => decodeURIComponent(x.getAttribute('src') || '').includes(d));
    if (!f) throw new Error('no frame for ' + d);
    const u = f.getAttribute('src') || '';
    f.setAttribute('src', u.replace(/([?&])dshreload=\d+/, '') + '&dshreload=' + Date.now());
  }, dir);
};

// ─── 准备：打开页面、放开实例池上限到 8 ───
await page.goto(TOKEN_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await dismissModals();
await page.evaluate(async () => {
  await fetch('/dsh-vscode/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { instancePoolSize: 8 } }) });
});
await page.waitForTimeout(2500);

// ─── V1：全新 folder（alpha）首开 → 专注布局 ───
await clickSessionByTitle(TITLES.alpha, 'alpha');
await openVscodeTab(3000);
for (let i = 0; i < 30 && (await srcList()).length === 0; i++) await page.waitForTimeout(1500);
const fa = await waitVsFrame('spaces/alpha');
await page.waitForTimeout(3000); // 等布局应用与副边栏容器渲染
const l1 = await layoutOf(fa);
check('V1 主边栏收起', l1.nosidebar && (l1.sidebar === null || l1.sidebar.w < 5), 'sidebar=' + JSON.stringify(l1.sidebar));
check('V1 编辑器区收起', l1.nomaineditorarea && (l1.editor === null || l1.editor.w < 5), 'editor=' + JSON.stringify(l1.editor));
check('V1 面板收起', l1.nopanel && (l1.panel === null || l1.panel.h < 5), 'panel=' + JSON.stringify(l1.panel));
check('V1 状态栏隐藏（boot 级键）', l1.nostatusbar && (l1.statusbar === null || l1.statusbar.h < 5), 'statusbar=' + JSON.stringify(l1.statusbar));
check('V1 活动栏保留（决策点）', !l1.noactivitybar && l1.activitybar && l1.activitybar.w > 10, 'activitybar=' + JSON.stringify(l1.activitybar));
check('V1 副边栏(Codex)最大化占满', focusedShape(l1), 'aux=' + JSON.stringify(l1.aux) + ' classes: ' + ['nosidebar', 'nomaineditorarea', 'nopanel', 'nostatusbar', 'noauxiliarybar', 'noactivitybar'].map((c) => c + '=' + l1[c]).join(' '));
check('V1 三键落盘 settings.json', (() => { const sj = settingsJson(); return sj['workbench.secondarySideBar.defaultVisibility'] === 'maximized' && sj['workbench.statusBar.visible'] === false && sj['workbench.startupEditor'] === 'none'; })(), settingsKeys(settingsJson()));
await shot('01-focus-alpha');

// 尽力把副边栏切到 CODEX 容器（首开默认容器可能是 CHAT，点一次即持久化）
try {
  const codexTab = page.frames().find((x) => /:18654/.test(x.url()) && decodeURIComponent(x.url()).includes('spaces/alpha'))
    .locator('.part.auxiliarybar .composite-bar li.action-item, .part.auxiliarybar .monaco-action-bar li.action-item')
    .filter({ hasText: /CODEX/i }).first();
  if ((await codexTab.count()) && (await codexTab.isVisible().catch(() => false))) { await codexTab.click(); await page.waitForTimeout(1500); }
} catch (e) { console.log('  [codex tab] ' + String(e).slice(0, 100)); }
await shot('02-focus-alpha-codex');

// ─── V2：用户显式打开主边栏（活动栏图标 / Ctrl+B）→ 解除最大化；重载后保留用户布局 ───
try {
  const abItem = fa.locator('.part.activitybar li.action-item').first();
  await abItem.click({ timeout: 5000 });
} catch (e) {
  await fa.locator('body').click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press('Control+b').catch(() => {});
}
await page.waitForTimeout(2000);
const l2 = await layoutOf(fa);
check('V2 显式打开主边栏 → 解除最大化（编辑器区还原）', normalShape(l2), 'sidebar=' + JSON.stringify(l2.sidebar) + ' editor=' + JSON.stringify(l2.editor));
await shot('03-focus-exited-user-layout');

// 给 web 端存储（IndexedDB，经 beforeunload/空闲 flush）留出落盘时间，再触发重载
await page.waitForTimeout(10000);
await reloadFrame('spaces/alpha');
const fa2 = await waitVsFrame('spaces/alpha', 'dshreload=');
await page.waitForTimeout(3000);
const l2b = await layoutOf(fa2);
check('V2 重载后保留用户布局（workspace 持久化，不被强拉）', normalShape(l2b), 'sidebar=' + JSON.stringify(l2b.sidebar) + ' editor=' + JSON.stringify(l2b.editor));
check('V2 重载后状态栏仍隐藏（settings 级键每次启动生效）', l2b.nostatusbar, 'nostatusbar=' + l2b.nostatusbar);
await shot('04-reload-keeps-user-layout');

// ─── V3：切到全新空间 beta → 新实例自动进专注 ───
await clickSessionByTitle(TITLES.beta, 'beta');
await openVscodeTab();
for (let i = 0; i < 30 && (await srcList()).length < 2; i++) await page.waitForTimeout(1500);
const fb = await waitVsFrame('spaces/beta');
await page.waitForTimeout(3000);
const l3 = await layoutOf(fb);
check('V3 全新空间 beta 自动进专注', focusedShape(l3), 'aux=' + JSON.stringify(l3.aux) + ' nosidebar=' + l3.nosidebar + ' nomaineditorarea=' + l3.nomaineditorarea);
await shot('05-focus-beta-fresh-space');

// ─── V4：关闭专注开关 → 收敛重载；gamma 全新空间不再自动最大化 ───
const via4 = await toggleFocus(false);
await page.waitForTimeout(4500); // 等客户端轮询差值(≤1.5s) + 收敛重载
const fa3 = await waitVsFrame('spaces/alpha');
await page.waitForTimeout(3000);
const l4a = await layoutOf(fa3);
check('V4 关闭专注：alpha 状态栏恢复', !l4a.nostatusbar && l4a.statusbar && l4a.statusbar.h > 5, 'statusbar=' + JSON.stringify(l4a.statusbar));
check('V4 关闭专注：alpha 保留用户布局', normalShape(l4a), 'sidebar=' + JSON.stringify(l4a.sidebar));
const l4b = await layoutOf(await waitVsFrame('spaces/beta'));
check('V4 关闭专注：beta 保持专注（wasLastMaximized 已持久化）', focusedShape(l4b), 'aux=' + JSON.stringify(l4b.aux));
check('V4 开关经 ' + via4 + ' 生效且三键已移除', (() => { const sj = settingsJson(); return !sj['workbench.secondarySideBar.defaultVisibility'] && sj['workbench.statusBar.visible'] === undefined && !sj['workbench.startupEditor']; })(), settingsKeys(settingsJson()));
await shot('06-focus-off-alpha');

await clickSessionByTitle(TITLES.gamma, 'gamma');
await openVscodeTab();
for (let i = 0; i < 30 && (await srcList()).length < 3; i++) await page.waitForTimeout(1500);
const fg = await waitVsFrame('spaces/gamma');
await page.waitForTimeout(3000);
const l4c = await layoutOf(fg);
check('V4 关闭专注：gamma 全新空间不自动最大化', !l4c.nomaineditorarea && !l4c.nosidebar, 'nosidebar=' + l4c.nosidebar + ' nomaineditorarea=' + l4c.nomaineditorarea);
check('V4 关闭专注：gamma 状态栏可见', !l4c.nostatusbar, 'nostatusbar=' + l4c.nostatusbar);
await shot('07-focus-off-gamma');

// ─── V5：重新开启专注 → delta 全新空间再次进专注 ───
const via5 = await toggleFocus(true);
await page.waitForTimeout(4500);
await clickSessionByTitle(TITLES.delta, 'delta');
await openVscodeTab();
for (let i = 0; i < 30 && (await srcList()).length < 4; i++) await page.waitForTimeout(1500);
const fd = await waitVsFrame('spaces/delta');
await page.waitForTimeout(3000);
const l5 = await layoutOf(fd);
check('V5 重新开启：delta 全新空间再次自动进专注', focusedShape(l5), 'aux=' + JSON.stringify(l5.aux) + ' classes: nosidebar=' + l5.nosidebar + ' nomaineditorarea=' + l5.nomaineditorarea + ' nostatusbar=' + l5.nostatusbar);
check('V5 开关经 ' + via5 + ' 生效且三键重新落盘', (() => { const sj = settingsJson(); return sj['workbench.secondarySideBar.defaultVisibility'] === 'maximized' && sj['workbench.statusBar.visible'] === false; })(), settingsKeys(settingsJson()));
await shot('08-focus-on-delta');

// ─── V6：设置页 UI 检查（只读：勾选框存在且状态与配置一致；截图为证，不写入）───
try {
  let opened = false;
  for (const sel of ['button:has-text("Settings")', 'text=Settings']) {
    const el = page.locator(sel).first();
    if ((await el.count()) && (await el.isVisible().catch(() => false))) {
      await el.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1400);
      opened = await page.getByText('VS Code Server', { exact: false }).first().isVisible().catch(() => false);
      if (opened) break;
    }
  }
  if (opened) {
    await page.getByText('VS Code Server', { exact: false }).first().click();
    await page.waitForTimeout(1200);
    const box = page.locator('label.dshvs-row', { hasText: '专注布局' }).locator('input[type="checkbox"]').first();
    const checked = await box.isChecked();
    check('V6 设置页「专注布局」勾选框存在且勾选=true', checked === true, 'checked=' + checked);
    await shot('09-focus-on-settings-ui');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(900);
  } else {
    console.log('  [V6] settings entry not found — log only');
  }
} catch (e) {
  console.log('  [V6] skipped: ' + String(e).slice(0, 120));
}

fs.writeFileSync(`${OUT}/e2e-results-0.1.21.json`, JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
const pass = results.filter((r) => r.ok).length;
console.log(`RESULT: ${pass}/${results.length} passed`);
await browser.close();
process.exit(pass === results.length ? 0 : 1);