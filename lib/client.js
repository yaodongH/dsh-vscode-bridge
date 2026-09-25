window.__ModuleLoader__.load({
	id: "dsh-vscode-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require('react');

		const CSS = [
			'.dshvs-shell { display:flex; flex-direction:column; gap:8px; height:calc(100vh - 150px); min-height:420px; padding:6px 2px; box-sizing:border-box; }',
			'.dshvs-bar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:12px; }',
			'.dshvs-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }',
			'.dshvs-btn { border:1px solid var(--dsw-border, rgba(128,128,128,.4)); background:transparent; border-radius:6px; padding:3px 10px; font-size:12px; cursor:pointer; color:inherit; text-decoration:none; }',
			'.dshvs-btn:hover { background: var(--dsw-hover, rgba(128,128,128,.12)); }',
			'.dshvs-btns { display:flex; gap:6px; margin-left:auto; }',
			'.dshvs-stage { flex:1 1 auto; width:100%; min-height:380px; border:1px solid var(--dsw-border, rgba(128,128,128,.25)); border-radius:8px; box-sizing:border-box; position:relative; overflow:hidden; background:#1e1e1e; }',
			'.dshvs-splash { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:#cfcfcf; font-size:13px; background:#1e1e1e; }',
			'.dshvs-spinner { width:26px; height:26px; border:3px solid rgba(255,255,255,.18); border-top-color:#4fa3ff; border-radius:50%; animation:dshvs-spin 0.9s linear infinite; }',
			'@keyframes dshvs-spin { to { transform: rotate(360deg); } }',
			'.dshvs-card { border:1px solid var(--dsw-border, rgba(128,128,128,.25)); border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:8px; font-size:13px; overflow:auto; }',
			'.dshvs-diag { white-space:pre-wrap; font-size:11px; line-height:1.5; opacity:.75; max-height:110px; overflow:auto; font-family:var(--dsw-font-mono, monospace); margin:0; }',
			'.dshvs-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:13px; }',
			'.dshvs-input { border:1px solid var(--dsw-border, rgba(128,128,128,.35)); border-radius:6px; padding:4px 8px; font-size:12px; background:transparent; color:inherit; flex:1 1 260px; }',
			'.dshvs-select { border:1px solid var(--dsw-border, rgba(128,128,128,.35)); border-radius:6px; padding:4px 8px; font-size:12px; background:transparent; color:inherit; flex:1 1 260px; }',
			'.dshvs-kv { color: var(--dsw-text-secondary, gray); font-size:12px; }',
			'.dshvs-modal { position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; }',
			'.dshvs-modalCard { width:min(560px, 92vw); max-height:80vh; overflow:auto; background:var(--dsw-bg, #232323); color:inherit; border:1px solid var(--dsw-border, rgba(128,128,128,.4)); border-radius:10px; padding:16px; display:flex; flex-direction:column; gap:10px; font-size:13px; box-shadow:0 12px 40px rgba(0,0,0,.5); }',
			'.dshvs-opt { display:flex; flex-direction:column; gap:2px; border:1px solid var(--dsw-border, rgba(128,128,128,.3)); border-radius:8px; padding:8px 10px; cursor:pointer; }',
			'.dshvs-opt:hover { background: var(--dsw-hover, rgba(128,128,128,.12)); }',
			'.dshvs-optTitle { font-size:13px; display:flex; align-items:center; }',
			'.dshvs-optMeta { font-size:11px; opacity:.7; word-break:break-all; padding-left:22px; }',
		].join('\n');

		const PHASE_LABELS = {
			loading: '连接宿主中…', unknown: '状态未知', stopped: '已停止', starting: '启动中…',
			running: '运行中', installing: '安装中', crashed: '进程异常退出',
			degraded: '反复崩溃（已达重试上限）', 'needs-install': '未安装', error: '宿主通信失败',
		};
		const DOT_COLOR = {
			running: '#28a745', starting: '#e2b203', installing: '#e2b203',
			crashed: '#d04549', degraded: '#d04549', 'needs-install': '#d08530',
		};
		const DEFAULT_POOL = 2;
		const MAX_POOL = 8;

		// sessions/workspaces 必须显式声明：ctx.<prop> 服务解析只对已 inject 的名字生效，
		// 且 ctx.get 的 store 映射不含未声明的服务名（0.1.9 未声明导致跟随从未生效）。
		var inject = ['slots', 'theme', 'sessions', 'workspaces'];

		function baseName(p) { return String(p).split('/').filter(Boolean).pop() || String(p); }

		function apply(ctx) {
			const slots = ctx.get('slots');
			if (slots === undefined) return;

			const styleEl = document.createElement('style');
			styleEl.setAttribute('data-dshvs', 'dsh-vscode-bridge');
			styleEl.textContent = CSS;
			document.head.appendChild(styleEl);
			ctx.effect(() => () => { styleEl.remove(); }, 'dsh-vscode-bridge: css');

			// —— 同源 HTTP 直连 Host 半区（/dsh-vscode/* 路由） ——
			const api = (path, init) => fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, init || {}))
				.then((r) => r.json().catch(() => ({})));
			const getStatus = () => api('/dsh-vscode/status');
			const control = (payload) => {
				return api('/dsh-vscode/control', { method: 'POST', body: JSON.stringify(payload || {}) }).then((s) => {
					setValue(s);
					return s;
				});
			};
			const getConfig = () => api('/dsh-vscode/config');
			const saveConfig = (patch) => api('/dsh-vscode/config', { method: 'POST', body: JSON.stringify({ patch: patch }) });

			// —— 实例池（0.1.16）：按 workspace 缓存 keep-alive iframe ——
			// 每个 folder 一个独立实例（body 直挂的 position:fixed 浮层 + iframe）：
			// 同空间会话互切命中同一实例（零重载、未保留状态不丢）；跨空间切换在池内
			// 秒切到已存活实例，池满时由视图弹窗让用户选择腾位实例。
			// iframe 节点在 DOM 中移动会整页重载，因此实例只切换可见性与几何、绝不移动。
			const pool = new Map();      // folder -> inst
			let activeInst = null;       // 当前显示实例
			let instSeq = 0;
			let pendingTheme = true;     // 下一次 iframe 启动应采用的深浅值（主题落盘后启动）
			const instSubs = new Set();
			const notifyInsts = () => { for (const l of Array.from(instSubs)) { try { l(); } catch (e) { /* 单个订阅失败不影响 */ } } };
			const subscribeInsts = (l) => { instSubs.add(l); return () => { instSubs.delete(l); }; };

			function poolLimit(raw) {
				const n = Math.floor(Number(raw));
				if (!Number.isFinite(n)) return DEFAULT_POOL;
				return Math.min(MAX_POOL, Math.max(1, n));
			}
			function makeInst(folder) {
				instSeq += 1;
				const host = document.createElement('div');
				host.style.cssText = 'position:fixed; display:none; z-index:1; margin:0; padding:0; background:#1e1e1e;';
				const frame = document.createElement('iframe');
				frame.title = 'VS Code';
				frame.setAttribute('allow', 'clipboard-read; clipboard-write; cross-origin-isolated');
				frame.style.cssText = 'width:100%; height:100%; border:0; display:block; background:#1e1e1e;';
				host.appendChild(frame);
				const inst = {
					id: instSeq, folder, host, frame,
					base: '',          // 基础 src（不含 dshreload 计数）
					bootTheme: null,   // 本次启动采用的深浅值（主题收敛判据）
					loaded: false,
					themeBump: 0,
					lastUsed: Date.now(),
				};
				// 每次导航完成记账：本次 workbench 启动采用的深浅值
				frame.addEventListener('load', () => { inst.bootTheme = pendingTheme; inst.loaded = true; notifyInsts(); });
				document.body.appendChild(host);
				pool.set(folder, inst);
				return inst;
			}
			function destroyInst(inst) {
				if (!inst) return;
				pool.delete(inst.folder);
				try { inst.frame.src = 'about:blank'; } catch (e) { /* 已卸载 */ }
				inst.host.remove();
				if (activeInst === inst) activeInst = null;
				notifyInsts();
			}
			function destroyAll() { for (const inst of Array.from(pool.values())) destroyInst(inst); }
			function adopt(inst) {
				activeInst = inst;
				inst.lastUsed = Date.now();
				notifyInsts();
				return inst;
			}
			function victimList() {
				return Array.from(pool.values()).sort((a, b) => a.lastUsed - b.lastUsed);
			}
			// 打开目标空间的新实例（冷启动）
			function openTarget(target) {
				const s = value;
				const serverUrl = s && s.server && s.server.url;
				const runMarker = (s && s.server && s.server.startedAt) ? String(s.server.startedAt) : '';
				if (!serverUrl) return null;
				const inst = makeInst(target);
				adopt(inst);
				bootInst(inst, serverUrl + '?folder=' + encodeURIComponent(target) + '&dshrun=' + encodeURIComponent(runMarker));
				return inst;
			}
			// —— 满池腾位弹窗（body 直挂命令式模态） ——
			// 必须挂在 body：视图组件树位于宿主 tab 单元格（grid 子项 z-index:10 的层叠上下文）内，
			// React 渲染的模态逃不出该上下文，会被 z=11 的 IDE 浮层压住、点不到按钮。
			let promptHost = null;
			// 用户对某目标点过「取消」后不再反复弹（切走再切回视为新请求，解除抑制）
			let declinedTarget = null;
			let lastRequestTarget = null;
			function hideEvictPrompt() {
				if (promptHost) { promptHost.remove(); promptHost = null; }
			}
			function showEvictPrompt(target, limit) {
				if (promptHost && promptHost.dataset.target === target) return;
				hideEvictPrompt();
				const host = document.createElement('div');
				host.className = 'dshvs-modal';
				host.setAttribute('data-dshvs-modal', 'evict');
				host.dataset.target = target;
				const card = document.createElement('div');
				card.className = 'dshvs-modalCard';
				const title = document.createElement('div');
				title.style.cssText = 'font-size:14px; font-weight:600;';
				title.textContent = 'VS Code 实例池已满';
				const desc = document.createElement('div');
				desc.className = 'dshvs-kv';
				desc.textContent = '打开「' + baseName(target) + '」需要新实例，实例池已满（上限 ' + limit +
					'）。选择要踢出的实例——其未保存文件由 VS Code 自身保存，重开该目录时可恢复：';
				card.appendChild(title);
				card.appendChild(desc);
				const victims = victimList();
				victims.forEach((inst, i) => {
					const label = document.createElement('label');
					label.className = 'dshvs-opt';
					if (i === 0) label.style.borderColor = '#4fa3ff';
					const t = document.createElement('span');
					t.className = 'dshvs-optTitle';
					const radio = document.createElement('input');
					radio.type = 'radio';
					radio.name = 'dshvs-evict';
					radio.value = inst.folder;
					radio.checked = i === 0;
					radio.style.marginRight = '8px';
					radio.addEventListener('change', () => {
						for (const el of card.querySelectorAll('.dshvs-opt')) el.style.borderColor = '';
						label.style.borderColor = '#4fa3ff';
					});
					t.appendChild(radio);
					t.appendChild(document.createTextNode(baseName(inst.folder) + (inst === activeInst ? '（当前显示）' : '')));
					const meta1 = document.createElement('span');
					meta1.className = 'dshvs-optMeta';
					meta1.textContent = inst.folder;
					const meta2 = document.createElement('span');
					meta2.className = 'dshvs-optMeta';
					meta2.textContent = '最近使用 ' + new Date(inst.lastUsed).toLocaleTimeString() + ' · ' + (inst.loaded ? '已加载' : '未加载');
					label.appendChild(t);
					label.appendChild(meta1);
					label.appendChild(meta2);
					card.appendChild(label);
				});
				const btns = document.createElement('div');
				btns.className = 'dshvs-btns';
				btns.style.marginTop = '4px';
				const cancel = document.createElement('button');
				cancel.className = 'dshvs-btn';
				cancel.textContent = '取消';
				cancel.addEventListener('click', () => { declinedTarget = target; hideEvictPrompt(); });
				const confirm = document.createElement('button');
				confirm.className = 'dshvs-btn';
				confirm.style.borderColor = '#4fa3ff';
				confirm.textContent = '踢出所选并打开';
				confirm.addEventListener('click', () => {
					const picked = card.querySelector('input[name="dshvs-evict"]:checked');
					const victimFolder = picked ? picked.value : null;
					hideEvictPrompt();
					if (victimFolder) {
						destroyInst(pool.get(victimFolder));
						openTarget(target);
					}
					notifyInsts();
				});
				btns.appendChild(cancel);
				btns.appendChild(confirm);
				card.appendChild(btns);
				host.appendChild(card);
				document.body.appendChild(host);
				promptHost = host;
			}
			// 切换决策：池内命中→秒切；未满→新建冷启动；已满→弹窗选腾位
			function requestTarget(target, limit) {
				if (target === declinedTarget) return;
				if (activeInst && activeInst.folder === target) { hideEvictPrompt(); return; }
				const hit = pool.get(target);
				if (hit) { adopt(hit); hideEvictPrompt(); notifyInsts(); return; }
				if (pool.size < limit) { hideEvictPrompt(); openTarget(target); return; }
				showEvictPrompt(target, limit);
			}
			// 主题设置只在 workbench 启动时读取一次：先推主题、落盘后再启动 iframe
			function bootInst(inst, urlBase) {
				inst.base = urlBase;
				inst.loaded = false;
				inst.bootTheme = null;
				const start = () => {
					if (inst.base !== urlBase || pool.get(inst.folder) !== inst) return;
					inst.frame.src = urlBase;
				};
				// 兜底：个别环境下 load 事件可能不触发，超时按已启动处理（避免永远停在 splash）
				setTimeout(() => { if (!inst.loaded && pool.get(inst.folder) === inst) { inst.loaded = true; notifyInsts(); } }, 2500);
				const p = pushTheme({ force: true, booting: true });
				if (p && typeof p.then === 'function') { p.then(start, start); } else { start(); }
			}
			// 主题收敛：settings.json 全局共享、workbench 只在启动时读一次，
			// 因此推值变化时把「启动值与目标值不符」的存活实例全部重载。
			function convergeTheme(dark) {
				for (const inst of Array.from(pool.values())) {
					if (!inst.loaded || !inst.base) continue;
					if (inst.bootTheme === dark) continue;
					inst.themeBump += 1;
					inst.frame.src = inst.base + '&dshreload=' + inst.themeBump;
				}
			}

			// —— 主题跟随：DSH 主题 → code-server workbench.colorTheme ——
			// workbench 只在**启动时**读取一次 user settings，之后不再跟随文件变化，
			// 因此主题链路必须收敛（0.1.15 起）：落盘先于启动 + 推值变化重载收敛。
			// 0.1.16 起收敛作用于实例池内全部存活实例。
			//   DSH 主题变化经 ctx 的 'theme/change' 事件发布（ThemeRuntime 无 subscribe），
			//   另在状态轮询里做零成本差值检查兜底。
			// 深浅取值：显式 preference（'dark'/'light'）优先，'system' 才按浏览器解析的
			// active.colorScheme——避免多客户端因系统深浅不同反复覆盖同一个设置文件。
			let themeService = null;
			try { themeService = ctx.get('theme'); } catch (e) { /* 服务未就绪：resolveDark 回退深色 */ }
			let lastPushedDark;
			let themeFollowOn = true;
			const resolveDark = () => {
				try {
					const snap = (themeService && themeService.getTheme) ? themeService.getTheme() : null;
					if (snap && snap.active) {
						if (snap.preference === 'dark') return true;
						if (snap.preference === 'light') return false;
						return snap.active.colorScheme === 'dark';
					}
				} catch (e) { /* 主题服务不可用：回退深色 */ }
				return true;
			};
			const pushTheme = (opts) => {
				const force = !!(opts && opts.force);
				const booting = !!(opts && opts.booting);
				const dark = resolveDark();
				pendingTheme = dark;
				if (!themeFollowOn) return null;
				if (!force && dark === lastPushedDark) return null;
				lastPushedDark = dark;
				const p = api('/dsh-vscode/theme', { method: 'POST', body: JSON.stringify({ dark: dark }) }).then(() => dark, () => dark);
				if (!booting) convergeTheme(dark);
				return p;
			};
			const offTheme = [];
			try {
				if (typeof ctx.on === 'function') {
					const off = ctx.on('theme/change', () => { pushTheme(); });
					if (typeof off === 'function') offTheme.push(off);
				}
			} catch (e) { /* 事件不可用：由状态轮询差值检查兜底 */ }
			try {
				if (themeService && typeof themeService.subscribe === 'function') {
					offTheme.push(themeService.subscribe(() => { pushTheme(); }));
				}
			} catch (e) { /* 订阅失败可忽略 */ }
			ctx.effect(() => () => { for (const off of offTheme) { try { off(); } catch (e) { /* 已释放 */ } } }, 'dsh-vscode-bridge: theme follow');
			pushTheme();

			// —— 打开目录跟随当前空间：解析当前会话所在 DSH 空间的目录 ——
			// 当前会话身份归视图侧所有：SessionListState 只保留 ids/byId/phase，不再有 current。
			// 取 id：路径 A：uiSession.adapter.current 的 StandardSourceBinding.key（main 选择）；
			//         路径 B：localStorage 的持久化 main 选择（dsh.sessions.current，未选中/服务未就绪时兜底）。
			// 取目录：路径1：sessions.byId[id].cwd（会话头 cwd 即所在空间目录）；
			//         路径2：workspaces.items 里 sessionIds 含该会话的记录 path。
			// 任一路径失效都返回 null（回退 config.workspacePath），trace 逐次上报宿主日志。
			// 读客户端服务：优先已声明注入的属性，其次严格 ctx.get（可选服务）。
			// 属性访问对未声明注入的名字会抛错，必须单独 try，否则会吞掉 ctx.get 这条路径。
			function clientService(name) {
				try {
					const viaProperty = ctx[name];
					if (viaProperty !== undefined) return viaProperty;
				} catch (e) { /* 未声明注入：退回 ctx.get */ }
				try { return ctx.get(name); } catch (e) { return null; }
			}
			function currentSessionId() {
				try {
					const uiSession = clientService('uiSession');
					const source = (uiSession && uiSession.adapter) ? uiSession.adapter.current : null;
					const binding = source ? (typeof source.getSnapshot === 'function' ? source.getSnapshot() : source.value) : null;
					if (binding && typeof binding.key === 'string' && binding.key) return { id: binding.key, src: 'ui' };
				} catch (e) { /* 视图服务不可用：退回持久化选择 */ }
				try {
					const raw = localStorage.getItem('dsh.sessions.current');
					const saved = raw ? JSON.parse(raw) : null;
					if (saved && typeof saved.sessionId === 'string' && saved.sessionId) return { id: saved.sessionId, src: 'saved' };
				} catch (e) { /* 持久化不可用：视为未选中 */ }
				return { id: null, src: 'none' };
			}
			function resolveSpaceDir() {
				const norm = (p) => String(p).replace(/\/+$/, '') || '/';
				const trace = [];
				const cur = currentSessionId();
				trace.push('C' + (cur.id ? 1 : 0) + ':' + cur.src);
				const sessions = clientService('sessions');
				trace.push('S' + (sessions ? 1 : 0));
				const workspaces = clientService('workspaces');
				trace.push('W' + (workspaces ? 1 : 0));
				if (cur.id) {
					try {
						const snap = (sessions && sessions.list && sessions.list.getSnapshot) ? sessions.list.getSnapshot() : null;
						const row = (snap && snap.byId) ? snap.byId[cur.id] : null;
						if (row && typeof row.cwd === 'string' && row.cwd.charAt(0) === '/') {
							return { dir: norm(row.cwd), src: 'session', trace: trace.join(',') };
						}
						trace.push('cwd' + (row && row.cwd === undefined ? '0' : '1'));
					} catch (e) { trace.push('E1'); }
					try {
						const wsnap = (workspaces && workspaces.list && workspaces.list.getSnapshot) ? workspaces.list.getSnapshot() : null;
						const items = (wsnap && Array.isArray(wsnap.items)) ? wsnap.items : [];
						const hit = items.find((it) => it && Array.isArray(it.sessionIds) && it.sessionIds.indexOf(cur.id) !== -1);
						if (hit && typeof hit.path === 'string' && hit.path.charAt(0) === '/') {
							return { dir: norm(hit.path), src: 'workspace', trace: trace.join(',') };
						}
					} catch (e) { trace.push('E2'); }
				}
				return { dir: null, src: 'none', trace: trace.join(',') };
			}
			// 订阅所有会影响「当前空间目录」的源：uiSession 的 main 选择、sessions/workspaces 快照。
			// 状态轮询只保证宿主状态变化时重渲染，不保证切换空间时重算目录，因此目录必须由订阅驱动。
			function subscribeSpaceDir(onChange) {
				const disposers = [];
				const push = () => { try { onChange(resolveSpaceDir()); } catch (e) { /* 单次解析失败不影响订阅 */ } };
				const watch = (source) => {
					if (!source || typeof source.subscribe !== 'function') return;
					try { disposers.push(source.subscribe(push)); } catch (e) { /* 订阅失败：退化为轮询重算 */ }
				};
				const uiSession = clientService('uiSession');
				watch(uiSession && uiSession.adapter ? uiSession.adapter.current : null);
				const sessions = clientService('sessions');
				watch(sessions && sessions.list);
				const workspaces = clientService('workspaces');
				watch(workspaces && workspaces.list);
				push();
				return () => { for (const d of disposers) { try { d(); } catch (e) { /* 已释放 */ } } };
			}
			function useSpaceDir() {
				const pair = React.useState(() => resolveSpaceDir());
				const setResolved = pair[1];
				React.useEffect(() => subscribeSpaceDir((next) => {
					setResolved((prev) => (prev.dir === next.dir && prev.src === next.src && prev.trace === next.trace) ? prev : next);
				}), []);
				return pair[0];
			}
			// 每次与宿主交互都顺带上报当前空间目录与解析 trace；宿主在启动/重启 code-server 时采用目录。
			// 兼容字符串（'restart'）与对象（{ action: 'ensure' }）两种入参形态。
			const ctl = (actionOrPayload) => {
				const payload = (typeof actionOrPayload === 'string') ? { action: actionOrPayload } : Object.assign({}, actionOrPayload);
				const resolved = resolveSpaceDir();
				payload.spaceTrace = resolved.src + '(' + resolved.trace + ')';
				if (resolved.dir) payload.folder = resolved.dir;
				return control(payload);
			};

			ctx.effect(() => () => { hideEvictPrompt(); destroyAll(); }, 'dsh-vscode-bridge: instance pool');

			// —— 层叠定位 ——
			// 实例 host 是 body 直挂的 position:fixed 浮层，必须盖过「包含舞台的整条层叠链」，
			// 否则 iframe 被宿主 tab 体压住：进程正常、状态条正常，页面一片黑。
			// 关键陷阱：z-index 对 **flex/grid 子项**即使 position:static 也生效并创建层叠上下文
			// （DSH 原生右栏 tab 单元格正是 grid 子项 + z-index:10），旧判定只认
			// position!=static 的祖先，恒算出 z=1 被压死。现按「定位元素 或 flex/grid 子项
			// 且 z-index 非 auto」计级；display:contents 的父盒不产生布局，沿上一跳找布局容器。
			function isStackedItem(el) {
				let p = el.parentElement;
				while (p && p !== document.body) {
					const d = getComputedStyle(p).display;
					if (d === 'contents') { p = p.parentElement; continue; }
					return d.indexOf('flex') !== -1 || d.indexOf('grid') !== -1;
				}
				return false;
			}
			function stackZAbove(rootEl) {
				let z = 1;
				let el = rootEl;
				while (el && el !== document.body) {
					const cs = getComputedStyle(el);
					if (cs.zIndex !== 'auto') {
						const n = parseInt(cs.zIndex, 10);
						const stacked = cs.position !== 'static' || isStackedItem(el);
						if (!Number.isNaN(n) && stacked && n >= z) z = n + 1;
					}
					el = el.parentElement;
				}
				return z;
			}
			function showIdeOver(inst, stageEl) {
				const sync = () => {
					const r = stageEl.getBoundingClientRect();
					if (r.width < 60 || r.height < 60) return;
					for (const other of pool.values()) { if (other !== inst) other.host.style.display = 'none'; }
					let z = stackZAbove(stageEl)
					inst.host.style.zIndex = String(z)
					inst.host.style.display = 'block';
					inst.host.style.left = r.left + 'px';
					inst.host.style.top = r.top + 'px';
					inst.host.style.width = r.width + 'px';
					inst.host.style.height = r.height + 'px';
					// 自愈终检：命中测试在覆盖中心须先打到本 iframe。被「包含舞台」的宿主层
					// 压住（宿主改用未知层叠机制）时抬 z 重试；不含舞台的真浮层
					// （弹窗/下拉/菜单）不抢层，仍留在上。
					const cx = Math.round(r.left + r.width / 2);
					const cy = Math.round(r.top + r.height / 2);
					for (let i = 0; i < 4; i++) {
						const top = document.elementFromPoint(cx, cy);
						if (!top || top === inst.frame || inst.host.contains(top)) return;
						if (!top.contains(stageEl)) return;
						const need = stackZAbove(top);
						z = (need > z) ? need : z + 10;
						if (z > 2000) return;
						inst.host.style.zIndex = String(z);
					}
				};
				sync();
				const ro = new ResizeObserver(sync);
				ro.observe(stageEl);
				window.addEventListener('resize', sync, true);
				window.addEventListener('scroll', sync, true);
				return () => {
					ro.disconnect();
					window.removeEventListener('resize', sync, true);
					window.removeEventListener('scroll', sync, true);
					inst.host.style.display = 'none';
				};
			}

			// —— 状态观测源：仅订阅时 1.5s 轮询 ——
			const EMPTY = { ok: true, loaded: false, phase: 'loading' };
			let value = EMPTY;
			const subs = new Set();
			const setValue = (v) => {
				if (v && v.config) themeFollowOn = v.config.themeFollow !== false;
				if (v !== value) { value = v; subs.forEach((l) => l()); }
			};
			const statusSource = {
				getSnapshot: () => value,
				subscribe: (l) => { subs.add(l); return () => { subs.delete(l); }; },
			};

			const intervalId = setInterval(() => {
				if (subs.size === 0) return;
				pushTheme(); // 轮询顺带做主题差值检查（无变化零请求，变化才推送并收敛）
				getStatus().then((s) => setValue(s)).catch((e) => setValue({ ok: true, loaded: true, phase: 'error', error: String((e && e.message) || e) }));
			}, 1500);
			ctx.effect(() => () => clearInterval(intervalId), 'dsh-vscode-bridge: status poll');

			const face = {
				hooks: { status: statusSource },
				control,
				getConfig,
				saveConfig,
			};

			// 优先嵌入 better-sidebar 右侧栏（不影响主界面交互）；
			// 未安装时回退为中心区视图，保证插件独立可用。
			let sidebarTries = 0
			function tryRegister() {
				const sidebar = ctx.get('betterSidebar');
				if (sidebar && sidebar.registerTab) {
					registerSidebarTab(sidebar);
					return
				}
				sidebarTries += 1
				if (sidebarTries <= 10) { setTimeout(tryRegister, 500); return }
				registerCenterFallback();
			}
			function registerSidebarTab(sidebar) {
				ctx.effect(() => sidebar.registerTab({
					id: 'dsh-vscode-bridge:ide',
					title: 'VS Code',
					order: 55,
					single: true,
					icon: (size) => React.createElement('svg', {
						width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
						stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
					},
						React.createElement('polyline', { points: '16 18 22 12 16 6' }),
						React.createElement('polyline', { points: '8 6 2 12 8 18' }),
					),
					component: (tabProps) => IdeTab(tabProps),
				}), 'dsh-vscode-bridge: sidebar tab');
			}
			function registerCenterFallback() {
				slots.inject('conversation.view', () => slots.register(
					{ name: 'conversation.view', id: 'vscode-ide', order: 10, label: 'VS Code', inject: () => face },
					VscodeView,
				));
			}
			tryRegister();
			slots.inject('settings.section', () => slots.register(
				{ name: 'settings.section', id: 'vscode-bridge', order: 90, label: 'VS Code Server', inject: () => face },
				VscodeSettings,
			));

			function PhaseChip({ status }) {
				const color = DOT_COLOR[status.phase] || '#7a7a7a';
				const label = PHASE_LABELS[status.phase] || String(status.phase);
				const suffix = (status.server && status.server.port) ? ('（端口 ' + status.server.port + '）') : '';
				return React.createElement('span', { className: 'dshvs-kv' },
					React.createElement('span', { className: 'dshvs-dot', style: { backgroundColor: color, marginRight: 6, display: 'inline-block' } }),
					'VS Code: ' + label + suffix,
				);
			}

			function ControlButtons({ status, control }) {
				const rows = [];
				if (status.phase === 'stopped' || status.phase === 'crashed' || status.phase === 'degraded' || status.phase === 'needs-install') rows.push(['start', '启动']);
				if (status.phase === 'running' || status.phase === 'starting') rows.push(['stop', '停止']);
				rows.push(['restart', '重启']);
				return React.createElement('span', { className: 'dshvs-btns' }, rows.map((p) => React.createElement('button', {
					key: p[0], className: 'dshvs-btn', onClick: () => control({ action: p[0] }).catch(() => {}),
				}, p[1])));
			}

			function statusBlurb(s) {
				if (s.phase === 'needs-install') return 'code-server 尚未安装。点击“启动”开始下载并安装固化版本' + (s.pinned ? ' v' + s.pinned.version : '') + '（一次性，约 224MB）。';
				if (s.phase === 'starting' || s.phase === 'installing') return '正在准备 code-server，状态每 1.5 秒自动刷新；安装在宿主侧进行，离开页面不影响。';
				if (s.phase === 'stopped') return 'code-server 已停止，点击“启动”打开。';
				if (s.phase === 'crashed' || s.phase === 'degraded') return 'code-server 进程异常退出。查看诊断输出，或点击“启动/重启”。';
				if (s.phase === 'loading' || s.phase === 'unknown') return '正在连接 VS Code 环境宿主…';
				return 'VS Code 环境状态: ' + (PHASE_LABELS[s.phase] || s.phase);
			}

			let lastRunMarker = '';

			// —— 视图模型：两个视图（better-sidebar 页签 / 中心区回退）共用同一套实例池逻辑 ——
			// 切换决策只在「视图处于展示态」时发生：池内命中→秒切；未满→新建冷启动；
			// 已满→弹窗让用户选腾位（可取消，取消则保持当前实例不变）。
			function useIdeView(status, visible) {
				const s = status || { phase: 'loading' };
				const cfg = s.config || {};
				const followOn = cfg.workspaceFollow !== false;
				const resolved = useSpaceDir();
				const ws = (followOn ? (resolved.dir || '') : '') || cfg.workspacePath || '';
				const followNote = followOn ? (resolved.dir ? '（跟随当前空间）' : '（未识别当前空间）') : '';
				const runMarker = (s.server && s.server.startedAt) ? String(s.server.startedAt) : '';
				const serverUrl = (s.server && s.server.url) ? s.server.url : null;
				const running = !!serverUrl && (s.phase === 'running' || s.phase === 'starting');
				const limit = poolLimit(cfg.instancePoolSize);

				const stagePair = React.useState(null);
				const stage = stagePair[0];
				const setStage = stagePair[1];
				const tickPair = React.useReducer((x) => x + 1, 0);
				const poolTick = tickPair[0];
				const bumpPool = tickPair[1];
				React.useEffect(() => subscribeInsts(bumpPool), []);

				React.useEffect(() => { pushTheme(); }, [visible]);

				// 挂载或切换空间（ws 变化）时 ensure 一次，顺带把当前空间目录上报宿主
				React.useEffect(() => {
					if (!ws) return;
					ctl('ensure').catch(() => {});
				}, [ws]);

				// code-server 重启（runMarker 变）→ 池内实例全部失效，重建目标实例
				React.useEffect(() => {
					if (!runMarker || lastRunMarker === runMarker) return;
					lastRunMarker = runMarker;
					destroyAll();
					bumpPool();
				}, [runMarker]);

				// 上限下调：按最近使用自动 LRU 收缩至合规（不弹窗；弹窗只属于「打开新实例」路径）
				React.useEffect(() => {
					let changed = false;
					while (pool.size > limit) {
						const victims = victimList();
						const victim = victims.find((it) => it !== activeInst);
						if (!victim) break;
						destroyInst(victim);
						changed = true;
					}
					if (changed) bumpPool();
				}, [limit, poolTick]);

				// 切换决策（requestTarget 内含：池内秒切 / 未满新建 / 已满弹窗腾位）
				React.useEffect(() => {
					if (!running || !serverUrl || !ws) return;
					if (!visible) return;
					if (lastRequestTarget !== ws) { lastRequestTarget = ws; declinedTarget = null; }
					requestTarget(ws, limit);
				}, [ws, visible, running, runMarker, limit, serverUrl, poolTick]);

				// 展示：把当前实例覆盖到舞台矩形；离开时隐藏（不卸载、不重载）
				const activeKey = activeInst ? activeInst.id : 0;
				React.useEffect(() => {
					if (!stage) return undefined;
					if (!running || !visible || !activeInst) return undefined;
					return showIdeOver(activeInst, stage);
				}, [stage, visible, running, activeKey]);

				const shownDir = activeInst ? activeInst.folder : '';
				const staleNote = (shownDir && ws && shownDir !== ws) ? '（实例池已满，仍显示 ' + baseName(shownDir) + '）' : '';
				const url = serverUrl ? (serverUrl + '?folder=' + encodeURIComponent(ws) + '&dshrun=' + encodeURIComponent(runMarker)) : null;
				const booting = running && (!activeInst || !activeInst.loaded);

				return {
					s, cfg, ws, followNote, runMarker, serverUrl, running, limit,
					stage, setStage,
					shownDir, staleNote, url, booting,
				};
			}

			function IdeBar({ s, m }) {
				return React.createElement('div', { className: 'dshvs-bar' },
					React.createElement(PhaseChip, { status: s }),
					React.createElement('span', { className: 'dshvs-kv' }, s.pinned ? 'v' + s.pinned.version : ''),
					React.createElement('span', { className: 'dshvs-kv', title: m.shownDir || m.ws },
						(m.shownDir || m.ws) ? ('打开: ' + baseName(m.shownDir || m.ws) + m.followNote + m.staleNote) : ''),
					React.createElement(ControlButtons, { status: s, control: ctl }),
					m.url ? React.createElement('a', {
						className: 'dshvs-btn',
						href: (m.shownDir ? ((activeInst && activeInst.base) || m.url) : m.url),
						target: '_blank', rel: 'noreferrer',
					}, '新窗口') : null,
				);
			}

			function IdeSplash({ s, m }) {
				return React.createElement('div', { className: 'dshvs-splash' },
					React.createElement('div', { className: 'dshvs-spinner' }),
					React.createElement('div', null, m.booting && m.running ? ('正在打开 ' + baseName(m.ws) + ' …') : statusBlurb(s)),
					(s.install && s.install.phase && s.install.phase !== 'done')
						? React.createElement('div', { className: 'dshvs-kv' }, '安装进度: ' + (s.install.message || '') + (typeof s.install.pct === 'number' ? (' ' + s.install.pct + '%') : ''))
						: null,
					s.diag ? React.createElement('pre', { className: 'dshvs-diag' }, s.diag) : null,
				);
			}

			function VscodeView(props) {
				const status = props.useStatus((s) => s);
				const m = useIdeView(status, true);
				const s = m.s;
				return React.createElement(React.Fragment, null,
					React.createElement('div', { className: 'dshvs-shell' },
						React.createElement(IdeBar, { s, m }),
						(s.error || s.lastError) ? React.createElement('pre', { className: 'dshvs-diag' }, [s.error, s.lastError].filter(Boolean).join('\n---\n')) : null,
						React.createElement('div', { className: 'dshvs-stage', ref: m.setStage },
							(m.booting || !m.running) ? React.createElement(IdeSplash, { s, m }) : null,
						),
					),
				);
			}

			// —— better-sidebar 页签：把当前实例覆盖进面板容器 ——
			function IdeTab(tabProps) {
				const status = useSideStatus();
				const m = useIdeView(status, tabProps.visible !== false);
				const s = m.s;
				return React.createElement(React.Fragment, null,
					React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, height: '100%', boxSizing: 'border-box' } },
						React.createElement(IdeBar, { s, m }),
						(s.error || s.lastError) ? React.createElement('pre', { className: 'dshvs-diag' }, [s.error, s.lastError].filter(Boolean).join('\n---\n')) : null,
						React.createElement('div', { className: 'dshvs-stage', ref: m.setStage, style: { minHeight: 200 } },
							(m.booting || !m.running) ? React.createElement(IdeSplash, { s, m }) : null,
						),
					),
				);
			}

			// better-sidebar 组件宿内的响应式读取（非 slot 渲染面，使用标准 uSES）
			function useSideStatus() {
				return React.useSyncExternalStore(statusSource.subscribe, statusSource.getSnapshot, statusSource.getSnapshot);
			}

			function VscodeSettings(props) {
				const status = props.useStatus((s) => s);
				const draftState = React.useState(null);
				const draft = draftState[0];
				const setDraft = draftState[1];
				const savedState = React.useState('');
				const saved = savedState[0];
				const setSaved = savedState[1];
				React.useEffect(() => {
					props.getConfig().then((c) => setDraft(Object.assign({ extraArgsText: (c.extraArgs || []).join(' ') }, c)))
						.catch((e) => setDraft({ fetchError: String((e && e.message) || e) }));
				}, []);
				if (!draft) return React.createElement('div', { className: 'dshvs-card' }, 'VS Code Server 配置读取中…');
				if (draft.fetchError) return React.createElement('div', { className: 'dshvs-card' }, '读取失败: ' + draft.fetchError);
				const upd = (k, v) => setDraft(Object.assign({}, draft, { [k]: v }));
				const field = (label, controlNode) => React.createElement('label', { className: 'dshvs-row' },
					React.createElement('span', { style: { minWidth: 150, fontSize: 12 } }, label), controlNode);
				const doSave = () => {
					props.saveConfig({
						serverMode: draft.serverMode === 'custom' ? 'custom' : 'pinned',
						customBinaryPath: draft.customBinaryPath || '',
						installDir: draft.installDir || '',
						dataDir: draft.dataDir || '',
						downloadDir: draft.downloadDir || '',
						port: Number(draft.port),
						workspacePath: draft.workspacePath || '',
						workspaceFollow: draft.workspaceFollow !== false,
						instancePoolSize: poolLimit(draft.instancePoolSize),
						autoStart: !!draft.autoStart,
						themeFollow: draft.themeFollow !== false,
						extraArgs: String(draft.extraArgsText || '').split(/\s+/).filter((x) => x.length > 0),
					}).then(() => { setSaved('已保存'); pushTheme(); return null; }).catch(() => {});
				};
				return React.createElement('div', { className: 'dshvs-card' },
					React.createElement('div', { className: 'dshvs-bar' },
						React.createElement(PhaseChip, { status: status || { phase: 'loading' } }),
						React.createElement('span', { className: 'dshvs-btns' },
							React.createElement('button', { className: 'dshvs-btn', onClick: doSave }, '保存配置'),
							React.createElement('button', { className: 'dshvs-btn', onClick: () => props.control({ action: 'restart' }).catch(() => {}) }, '重启 code-server'),
						),
					),
					(status && status.openDir) ? React.createElement('div', { className: 'dshvs-kv', title: status.openDir }, '当前打开目录: ' + status.openDir) : null,
					saved ? React.createElement('div', { className: 'dshvs-kv' }, saved) : null,
					React.createElement('div', { className: 'dshvs-kv' }, '固化版本: code-server v' + ((status && status.pinned) ? status.pinned.version : '…') + '（升级固化版本通过发布新版 bundle 完成）'),
					React.createElement('div', { className: 'dshvs-row' }, React.createElement('span', { style: { minWidth: 150, fontSize: 12 } }, '服务器来源'),
						React.createElement('select', { className: 'dshvs-select', value: draft.serverMode || 'pinned', style: { minWidth: 260 }, onChange: (e) => upd('serverMode', e.target.value) },
							React.createElement('option', { value: 'pinned' }, 'pinned —— 使用插件固化版本（自动下载安装）'),
							React.createElement('option', { value: 'custom' }, 'custom —— 使用自定义 code-server 可执行文件'),
						)),
				field('自定义二进制路径', React.createElement('input', { className: 'dshvs-input', value: draft.customBinaryPath || '', placeholder: '例如 /usr/bin/code-server', onChange: (e) => upd('customBinaryPath', e.target.value) })),
				field('端口', React.createElement('input', { className: 'dshvs-input', type: 'number', value: draft.port, onChange: (e) => upd('port', e.target.value) })),
				field('工作区路径（跟随关闭时的默认打开目录）', React.createElement('input', { className: 'dshvs-input', value: draft.workspacePath || '', onChange: (e) => upd('workspacePath', e.target.value) })),
				field('打开目录跟随当前空间', React.createElement('input', { type: 'checkbox', checked: draft.workspaceFollow !== false, onChange: (e) => upd('workspaceFollow', e.target.checked) })),
				field('实例池上限（保留的 VS Code 实例数）', React.createElement('input', {
					className: 'dshvs-input', type: 'number', value: draft.instancePoolSize == null ? DEFAULT_POOL : draft.instancePoolSize,
					min: 1, max: MAX_POOL,
					onChange: (e) => upd('instancePoolSize', e.target.value),
				})),
				field('安装目录', React.createElement('input', { className: 'dshvs-input', value: draft.installDir || '', onChange: (e) => upd('installDir', e.target.value) })),
				field('数据目录', React.createElement('input', { className: 'dshvs-input', value: draft.dataDir || '', onChange: (e) => upd('dataDir', e.target.value) })),
				field('下载缓存目录', React.createElement('input', { className: 'dshvs-input', value: draft.downloadDir || '', onChange: (e) => upd('downloadDir', e.target.value) })),
				field('会话打开时自动启动', React.createElement('input', { type: 'checkbox', checked: !!draft.autoStart, onChange: (e) => upd('autoStart', e.target.checked) })),
				field('主题跟随 DSH', React.createElement('input', { type: 'checkbox', checked: draft.themeFollow !== false, onChange: (e) => upd('themeFollow', e.target.checked) })),
				field('附加参数（空格分隔）', React.createElement('input', { className: 'dshvs-input', value: draft.extraArgsText || '', placeholder: '例如 --disable-get-started-banner', onChange: (e) => upd('extraArgsText', e.target.value) })),
					React.createElement('div', { className: 'dshvs-kv' }, '「打开目录跟随当前空间」开启时，VS Code 打开当前会话所在空间（会话 cwd）的目录；关闭或会话无目录时使用「工作区路径」。「实例池上限」按 workspace 缓存 VS Code 实例（默认 2）：同空间会话互切不重载，跨空间切换秒切；池满时弹窗选择要踢出的实例。改端口/目录/来源后需重启 code-server 生效；配置持久化在工作区 .dsh/vscode-bridge/config.json。'),
					(status && (status.error || status.lastError)) ? React.createElement('pre', { className: 'dshvs-diag' }, String(status.error || status.lastError)) : null,
				);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
