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

		// sessions/workspaces 必须显式声明：ctx.<prop> 服务解析只对已 inject 的名字生效，
		// 且 ctx.get 的 store 映射不含未声明的服务名（0.1.9 未声明导致跟随从未生效）。
		var inject = ['slots', 'theme', 'sessions', 'workspaces'];

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

			// —— 主题跟随：DSH 主题 → code-server workbench.colorTheme ——
			// workbench 只在**启动时**读取一次 user settings，之后不再跟随文件变化，
			// 因此主题链路必须收敛（0.1.15 修复三处）：
			//   1) 落盘必须先于 iframe 启动：先推主题、等 POST 结束再给 src，
			//      否则启动读到旧值就永远停在旧主题（DSH 深色 / VS Code 浅色的直接原因）；
			//   2) 已启动的 workbench 不会跟随后续写入：推值变化时重载保活 iframe 收敛；
			//   3) DSH 主题变化经 ctx 的 'theme/change' 事件发布（ThemeRuntime 无 subscribe），
			//      旧代码只在挂载时推一次；另在状态轮询里做零成本差值检查兜底。
			// 深浅取值：显式 preference（'dark'/'light'）优先，'system' 才按浏览器解析的
			// active.colorScheme——避免多客户端因系统深浅不同反复覆盖同一个设置文件。
			let themeService = null;
			try { themeService = ctx.get('theme'); } catch (e) { /* 服务未就绪：resolveDark 回退深色 */ }
			let lastPushedDark;
			let pendingTheme = true;
			let bootTheme = null;
			let frameLoaded = false;
			let themeBump = 0;
			let themeFollowOn = true;
			const reloadIde = () => {
				const base = ideFrame.dataset.src;
				if (!base) return;
				themeBump += 1;
				ideFrame.src = base + '&dshreload=' + themeBump;
			};
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
				if (!booting && frameLoaded && bootTheme !== dark) reloadIde();
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

			// —— keep-alive 单例 iframe：切走标签页不卸载、不重载、保留编辑器状态 ——
			const keepHost = document.createElement('div');
			keepHost.style.cssText = 'position:fixed; display:none; z-index:1; margin:0; padding:0; background:#1e1e1e;';
			const ideFrame = document.createElement('iframe');
			ideFrame.title = 'VS Code';
			ideFrame.setAttribute('allow', 'clipboard-read; clipboard-write; cross-origin-isolated');
			ideFrame.style.cssText = 'width:100%; height:100%; border:0; display:block; background:#1e1e1e;';
			keepHost.appendChild(ideFrame);
			// 每次导航完成都记账「本次 workbench 启动时采用的深浅值」，供主题收敛判断。
			ideFrame.addEventListener('load', () => { bootTheme = pendingTheme; frameLoaded = true; });
			document.body.appendChild(keepHost);
			ctx.effect(() => () => { keepHost.remove(); ideFrame.src = 'about:blank'; }, 'dsh-vscode-bridge: keepalive host');
			// iframe 节点在 DOM 中移动会整页重载；keepHost 生命周期与插件一致，绝不移动节点，只切换可见性与几何。
			// —— 层叠定位 ——
			// keepHost 是 body 直挂的 position:fixed 浮层，必须盖过「包含舞台的整条层叠链」，
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
			function showIdeOver(stageEl) {
				const sync = () => {
					const r = stageEl.getBoundingClientRect();
					if (r.width < 60 || r.height < 60) return;
					let z = stackZAbove(stageEl)
					keepHost.style.zIndex = String(z)
					keepHost.style.display = 'block';
					keepHost.style.left = r.left + 'px';
					keepHost.style.top = r.top + 'px';
					keepHost.style.width = r.width + 'px';
					keepHost.style.height = r.height + 'px';
					// 自愈终检：命中测试在覆盖中心须先打到本 iframe。被「包含舞台」的宿主层
					// 压住（宿主改用未知层叠机制）时抬 z 重试；不含舞台的真浮层
					// （弹窗/下拉/菜单）不抢层，仍留在上。
					const cx = Math.round(r.left + r.width / 2);
					const cy = Math.round(r.top + r.height / 2);
					for (let i = 0; i < 4; i++) {
						const top = document.elementFromPoint(cx, cy);
						if (!top || top === ideFrame || keepHost.contains(top)) return;
						if (!top.contains(stageEl)) return;
						const need = stackZAbove(top);
						z = (need > z) ? need : z + 10;
						if (z > 2000) return;
						keepHost.style.zIndex = String(z);
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
					keepHost.style.display = 'none';
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

			function Notes({ status }) {
				const bits = [];
				if (status.error) bits.push(status.error);
				if (status.lastError && status.lastError !== status.error) bits.push(status.lastError);
				if (bits.length === 0) return null;
				return React.createElement('pre', { className: 'dshvs-diag' }, bits.join('\n---\n'));
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

			function VscodeView(props) {
				const status = props.useStatus((s) => s);
				const stagePair = React.useState(null);
				const stage = stagePair[0];
				const setStage = stagePair[1];
				const readyPair = React.useState(true);
				const frameReady = readyPair[0];
				const setFrameReady = readyPair[1];

				React.useEffect(() => { pushTheme(); }, []);

				const s = status || { phase: 'loading' };
				const cfg = s.config || {};
				const followOn = cfg.workspaceFollow !== false;
				// 打开目录：跟随模式解析当前会话所在空间目录，否则用配置的 workspacePath。
				// 目录放进 state 并由 subscribeSpaceDir 驱动更新：切换空间时立刻跟随，不依赖状态轮询。
				const resolved = useSpaceDir();
				const ws = (followOn ? (resolved.dir || '') : '') || cfg.workspacePath || '';
				const followNote = followOn ? (resolved.dir ? '（跟随当前空间）' : '（未识别当前空间）') : '';
				const runMarker = (s.server && s.server.startedAt) ? String(s.server.startedAt) : '';
				const url = (s.server && s.server.url)
					? (s.server.url + '?folder=' + encodeURIComponent(ws) + '&dshrun=' + encodeURIComponent(runMarker))
					: null;
				const active = url && (s.phase === 'running' || s.phase === 'starting');

				// 挂载或切换空间（ws 变化）时 ensure 一次，顺带把当前空间目录上报宿主
				React.useEffect(() => {
					if (!ws) return;
					ctl('ensure').catch(() => {});
				}, [ws]);

				// 服务重启或打开目录变化后强制重载 iframe（src 变化 → 重新进入工作台）
				React.useEffect(() => {
					if (!url || !runMarker) return;
					if (lastRunMarker !== runMarker || ideFrame.dataset.src !== url) {
						lastRunMarker = runMarker;
						setFrameReady(false);
						ideFrame.dataset.src = url;
						// 主题设置只在 workbench 启动时读取一次：先推主题、落盘后再启动 iframe，
						// 否则启动读到旧值就永远停在旧主题。
						const start = () => { if (ideFrame.dataset.src === url) ideFrame.src = url; };
						const p = pushTheme({ force: true, booting: true });
						if (p && typeof p.then === 'function') { p.then(start, start); } else { start(); }
					}
				}, [url, runMarker]);

				React.useEffect(() => {
					if (!url) return undefined;
					const onLoad = () => setFrameReady(true);
					const fallback = () => { if (ideFrame.dataset.src === url) setFrameReady(true); };
					ideFrame.addEventListener('load', onLoad);
					const t = setInterval(() => { if (ideFrame.dataset.src === url) fallback(); }, 1500);
					return () => { ideFrame.removeEventListener('load', onLoad); clearInterval(t); };
				}, [url]);

				// 激活时把保活 iframe 覆盖到舞台矩形；离开时隐藏（不卸载、不重载）
				React.useEffect(() => {
					if (!stage) return undefined;
					if (!active) return undefined;
					return showIdeOver(stage);
				}, [stage, active, url]);

				return React.createElement('div', { className: 'dshvs-shell' },
					React.createElement('div', { className: 'dshvs-bar' },
						React.createElement(PhaseChip, { status: s }),
						React.createElement('span', { className: 'dshvs-kv' }, s.pinned ? '固化 v' + s.pinned.version : ''),
						React.createElement('span', { className: 'dshvs-kv', title: ws }, ws ? ('打开: ' + (ws.split('/').filter(Boolean).pop() || ws) + followNote) : ''),
						React.createElement(ControlButtons, { status: s, control: ctl }),
						url ? React.createElement('a', { className: 'dshvs-btn', href: (ideFrame.dataset.src || url), target: '_blank', rel: 'noreferrer' }, '新窗口') : null,
					),
					(s.error || s.lastError) ? React.createElement('pre', { className: 'dshvs-diag' }, [s.error, s.lastError].filter(Boolean).join('\n---\n')) : null,
					React.createElement('div', { className: 'dshvs-stage', ref: setStage },
						(!active || !frameReady)
							? React.createElement('div', { className: 'dshvs-splash' },
								React.createElement('div', { className: 'dshvs-spinner' }),
								React.createElement('div', null, statusBlurb(s)),
								(s.install && s.install.phase && s.install.phase !== 'done')
									? React.createElement('div', { className: 'dshvs-kv' }, '安装进度: ' + (s.install.message || '') + (typeof s.install.pct === 'number' ? (' ' + s.install.pct + '%') : ''))
									: null,
								s.diag ? React.createElement('pre', { className: 'dshvs-diag' }, s.diag) : null,
							)
							: null,
					),
				);
			}

			// —— better-sidebar 页签：直接把保活 iframe 挂进面板容器 ——
			function IdeTab(tabProps) {
				const status = useSideStatus();
				const stagePair = React.useState(null);
				const stage = stagePair[0];
				const setStage = stagePair[1];
				const readyPair = React.useState(true);
				const frameReady = readyPair[0];
				const setFrameReady = readyPair[1];

				React.useEffect(() => { pushTheme(); }, [tabProps.visible]);

				const s = status || { phase: 'loading' };
				const cfg = s.config || {};
				const followOn = cfg.workspaceFollow !== false;
				// 打开目录：跟随模式解析当前会话所在空间目录，否则用配置的 workspacePath。
				// 目录放进 state 并由 subscribeSpaceDir 驱动更新：切换空间时立刻跟随，不依赖状态轮询。
				const resolved = useSpaceDir();
				const ws = (followOn ? (resolved.dir || '') : '') || cfg.workspacePath || '';
				const followNote = followOn ? (resolved.dir ? '（跟随当前空间）' : '（未识别当前空间）') : '';
				const runMarker = (s.server && s.server.startedAt) ? String(s.server.startedAt) : '';
				const url = (s.server && s.server.url)
					? (s.server.url + '?folder=' + encodeURIComponent(ws) + '&dshrun=' + encodeURIComponent(runMarker))
					: null;
				const active = url && (s.phase === 'running' || s.phase === 'starting');

				// 挂载或切换空间（ws 变化）时 ensure 一次，顺带把当前空间目录上报宿主
				React.useEffect(() => {
					if (!ws) return;
					ctl('ensure').catch(() => {});
				}, [ws]);

				React.useEffect(() => {
					if (!url || !runMarker) return;
					if (lastRunMarker !== runMarker || ideFrame.dataset.src !== url) {
						lastRunMarker = runMarker;
						setFrameReady(false);
						ideFrame.dataset.src = url;
						ideFrame.src = url;
					}
				}, [url, runMarker]);

				React.useEffect(() => {
					if (!url) return undefined;
					const onLoad = () => setFrameReady(true);
					const fallback = () => { if (ideFrame.dataset.src === url) setFrameReady(true); };
					ideFrame.addEventListener('load', onLoad);
					const t = setInterval(() => { if (ideFrame.dataset.src === url) fallback(); }, 1500);
					return () => { ideFrame.removeEventListener('load', onLoad); clearInterval(t); };
				}, [url]);

				// visible = 页签激活且面板展开；否则保活隐藏（不卸载、不重载）
				React.useEffect(() => {
					if (!stage) return undefined;
					if (!active) return undefined;
					if (!tabProps.visible) return undefined;
					return showIdeOver(stage);
				}, [stage, tabProps.visible, active, url]);

				return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, height: '100%', boxSizing: 'border-box' } },
					React.createElement('div', { className: 'dshvs-bar' },
						React.createElement(PhaseChip, { status: s }),
						React.createElement('span', { className: 'dshvs-kv' }, s.pinned ? 'v' + s.pinned.version : ''),
						React.createElement('span', { className: 'dshvs-kv', title: ws }, ws ? ('打开: ' + (ws.split('/').filter(Boolean).pop() || ws) + followNote) : ''),
						React.createElement(ControlButtons, { status: s, control: ctl }),
						url ? React.createElement('a', { className: 'dshvs-btn', href: (ideFrame.dataset.src || url), target: '_blank', rel: 'noreferrer' }, '新窗口') : null,
					),
					(s.error || s.lastError) ? React.createElement('pre', { className: 'dshvs-diag' }, [s.error, s.lastError].filter(Boolean).join('\n---\n')) : null,
					React.createElement('div', { className: 'dshvs-stage', ref: setStage, style: { minHeight: 200 } },
						(!active || !frameReady)
							? React.createElement('div', { className: 'dshvs-splash' },
								React.createElement('div', { className: 'dshvs-spinner' }),
								React.createElement('div', null, statusBlurb(s)),
								(s.install && s.install.phase && s.install.phase !== 'done')
									? React.createElement('div', { className: 'dshvs-kv' }, '安装进度: ' + (s.install.message || '') + (typeof s.install.pct === 'number' ? (' ' + s.install.pct + '%') : ''))
									: null,
							)
							: null,
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
				field('安装目录', React.createElement('input', { className: 'dshvs-input', value: draft.installDir || '', onChange: (e) => upd('installDir', e.target.value) })),
				field('数据目录', React.createElement('input', { className: 'dshvs-input', value: draft.dataDir || '', onChange: (e) => upd('dataDir', e.target.value) })),
				field('下载缓存目录', React.createElement('input', { className: 'dshvs-input', value: draft.downloadDir || '', onChange: (e) => upd('downloadDir', e.target.value) })),
				field('会话打开时自动启动', React.createElement('input', { type: 'checkbox', checked: !!draft.autoStart, onChange: (e) => upd('autoStart', e.target.checked) })),
				field('主题跟随 DSH', React.createElement('input', { type: 'checkbox', checked: draft.themeFollow !== false, onChange: (e) => upd('themeFollow', e.target.checked) })),
				field('附加参数（空格分隔）', React.createElement('input', { className: 'dshvs-input', value: draft.extraArgsText || '', placeholder: '例如 --disable-get-started-banner', onChange: (e) => upd('extraArgsText', e.target.value) })),
					React.createElement('div', { className: 'dshvs-kv' }, '「打开目录跟随当前空间」开启时，VS Code 打开当前会话所在空间（会话 cwd）的目录；关闭或会话无目录时使用「工作区路径」。改端口/目录/来源后需重启 code-server 生效；配置持久化在工作区 .dsh/vscode-bridge/config.json。'),
					(status && (status.error || status.lastError)) ? React.createElement('pre', { className: 'dshvs-diag' }, String(status.error || status.lastError)) : null,
				);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});