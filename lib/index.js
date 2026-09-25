/**
 * dsh-vscode-bridge — 中心区视图内嵌固定版本 code-server（VS Code Web）。
 * Host 半区：固化版本安装器（下载→sha256→解压→manifest 幂等）、子进程生命周期
 * （仅回环、--auth none、健康轮询、树级终止、崩溃退避重启）、同源 HTTP RPC 面
 * （/dsh-vscode/* 经 DSH webServer 注册，Client 半区同源 fetch）。
 * 插件自有文件（config/manifest/yaml）直接用 node:fs——不经过宿主 fs 服务的
 * 路径映射，保证幂等检查与字面磁盘状态一致。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const name = 'dsh-vscode-bridge'
export const inject = ['timer', 'subprocess', 'webServer']

export function apply(ctx) {
  const PIN = {
    version: '4.135.0',
    asset: 'code-server-4.135.0-linux-amd64.tar.gz',
    url: 'https://github.com/coder/code-server/releases/download/v4.135.0/code-server-4.135.0-linux-amd64.tar.gz',
    sha256: '300ef4e37e469e6368a4673c6a623e1c9ba8a34f42b394fb49c431a8900bc7d1',
    size: 235209481,
    root: 'code-server-4.135.0-linux-amd64',
    // code-server 4.135.0 对应的上游 VS Code 1.135.0 发布 commit。该 code-server 构建
    // 缺少内置扩展的浏览器端资源（dist/browser/**），ensureBuiltinWebBundles 会从
    // vscode.dev 官方 CDN 按此 commit 自动补齐。更换固化版本时必须同步更新此字段。
    vscodeCdnCommit: '08d4889f9ec4a1685d257b9b95de036c8e1ce1e5',
  }
  const WORKSPACE = '/home/huangyaodong/deepseek-harness-workspace'
  const DEFAULTS = {
    serverMode: 'pinned',
    customBinaryPath: '',
    installDir: WORKSPACE + '/.dsh/vscode-bridge/install',
    dataDir: WORKSPACE + '/.dsh/vscode-bridge/data',
    downloadDir: WORKSPACE + '/.dsh/vscode-bridge/downloads',
    port: 18643,
    workspacePath: WORKSPACE,
    autoStart: true,
    themeFollow: true,
    // 打开目录是否跟随「当前会话所在 DSH 空间」的目录（client 半区上报会话 cwd）。
    // 关闭后固定使用 workspacePath。
    workspaceFollow: true,
    extraArgs: [],
  }
  const RESERVED_FLAGS = ['--auth', '--bind-addr', '--user-data-dir', '--extensions-dir', '--config']

  const sp = ctx.get('subprocess')
  const webServer = ctx.get('webServer')
  if (!sp || !webServer) throw new Error('dsh-vscode-bridge: subprocess/webServer 服务为必需能力')

  const rt = {
    phase: 'stopped', intentRunning: false, server: undefined, install: null,
    startedAt: 0, restarts: 0, diag: '', stdoutOff: 0, stderrOff: 0, lastError: '', startedKey: null,
    // client 半区最近一次上报的「当前空间目录」；启动/重启 code-server 时优先于 workspacePath。
    clientFolder: null,
    // client 端空间目录解析 trace（session/workspace/none + 各服务可用性），仅记变化。
    lastSpaceTrace: '',
  }
  let config = Object.assign({}, DEFAULTS)
  let job = null

  const cfgPath = WORKSPACE + '/.dsh/vscode-bridge/config.json'
  const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? '…' + t.slice(-n) : t }
  const errText = (e) => (e && e.message) ? e.message : String(e)

  function drainTail() {
    const h = rt.server
    if (!h || !h.collected) return
    try {
      if (h.collected.stdout) {
        const r = h.collected.stdout.readFrom(rt.stdoutOff)
        rt.stdoutOff = r.nextOffset
        if (r.text) rt.diag = clip(rt.diag + r.text, 8000)
      }
      if (h.collected.stderr) {
        const r = h.collected.stderr.readFrom(rt.stderrOff)
        rt.stderrOff = r.nextOffset
        if (r.text) rt.diag = clip(rt.diag + r.text, 8000)
      }
    } catch (e) { console.error('dsh-vscode-bridge: drainTail 失败: ' + errText(e)) }
  }

  async function sh(argv, opts) {
    const o = opts || {}
    const bin = await sp.resolveExecutable(argv[0])
    const h = sp.spawn({
      argv: [bin].concat(argv.slice(1)),
      cwd: o.cwd || WORKSPACE,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: o.graceMs || 15000,
    })
    const exit = await h.done
    const read = (r) => { try { return r ? r.readFrom(0).text : '' } catch (e) { return '' } }
    return { code: exit.exitCode, signal: exit.signal, stdout: read(h.collected && h.collected.stdout), stderr: read(h.collected && h.collected.stderr) }
  }

  function ensureDirs(paths) {
    for (const p of paths) mkdirSync(p, { recursive: true })
  }

  function fileSize(p) {
    try { return lstatSync(p).size } catch (e) { return 0 }
  }

  function readConfig() {
    try {
      const raw = readFileSync(cfgPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config.json 不是对象')
      config = Object.assign({}, DEFAULTS, parsed)
      if (!Array.isArray(config.extraArgs)) config.extraArgs = []
    } catch (e) {
      config = Object.assign({}, DEFAULTS)
      config.extraArgs = []
    }
  }

  function writeConfig() {
    mkdirSync(WORKSPACE + '/.dsh/vscode-bridge', { recursive: true })
    writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n')
  }

  function pinnedBinary() { return config.installDir + '/' + PIN.root + '/bin/code-server' }

  async function ensureInstall() {
    if (config.serverMode === 'custom') {
      const bin = String(config.customBinaryPath || '').trim()
      if (!bin) throw new Error('serverMode=custom：请先在设置页填写 code-server 可执行文件路径')
      try { await sp.resolveExecutable(bin) } catch (e) { throw new Error('customBinaryPath 无法解析: ' + bin) }
      return { mode: 'custom', binary: bin }
    }
    const bin = pinnedBinary()
    let have = false
    try {
      const m = JSON.parse(readFileSync(config.installDir + '/manifest.json', 'utf8'))
      have = m.version === PIN.version && m.sha256 === PIN.sha256 && m.asset === PIN.asset && existsSync(bin)
    } catch (e) { have = false }
    if (have) { await ensureBuiltinWebBundles(config.installDir); return { mode: 'pinned', binary: bin } }

    rt.phase = 'installing'
    ensureDirs([config.installDir, config.downloadDir])
    const tmp = config.downloadDir + '/' + PIN.asset
    rt.install = { phase: 'download', pct: 0, message: '下载 ' + PIN.asset }
    console.log('dsh-vscode-bridge: 开始下载固化版本 ' + PIN.version)
    const cbin = await sp.resolveExecutable('curl')
    const dl = sp.spawn({
      argv: [cbin, '-fsSL', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '30', '-o', tmp, PIN.url],
      cwd: WORKSPACE,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: 10000,
    })
    const prog = ctx.interval(() => {
      if (rt.install && rt.install.phase === 'download') {
        const n = fileSize(tmp)
        rt.install.pct = Math.min(99, Math.round(n * 100 / PIN.size))
        rt.install.message = '下载中 ' + Math.round(n / 1048576) + '/' + Math.round(PIN.size / 1048576) + 'MB'
      }
    }, 1500)
    let exit
    try { exit = await dl.done } finally { prog() }
    let dlErr = ''
    try { dlErr = (dl.collected && dl.collected.stderr) ? dl.collected.stderr.readFrom(0).text : '' } catch (e) { dlErr = '' }
    if (exit.exitCode !== 0) {
      rt.install = { phase: 'failed', pct: 0, message: '下载失败（exit ' + exit.exitCode + '）' }
      throw new Error('code-server 下载失败: ' + clip(dlErr, 400))
    }
    rt.install = { phase: 'verify', pct: 100, message: '校验 sha256 …' }
    const sum = await sh(['sha256sum', tmp])
    if (sum.code !== 0) throw new Error('sha256 计算失败: ' + clip(sum.stderr, 300))
    const actual = String(sum.stdout).trim().split(/\s+/)[0]
    if (actual !== PIN.sha256) {
      rt.install = { phase: 'failed', pct: 0, message: 'sha256 与固化清单不一致' }
      throw new Error('固化版本校验失败: 期望 ' + PIN.sha256 + ' 实际 ' + actual)
    }
    if (String(config.installDir).indexOf(WORKSPACE) !== 0) throw new Error('installDir 必须位于工作区内: ' + config.installDir)
    rmSync(config.installDir, { recursive: true, force: true })
    ensureDirs([config.installDir])
    rt.install = { phase: 'extract', pct: 100, message: '解压到 ' + config.installDir }
    const te = await sh(['tar', '-xzf', tmp, '-C', config.installDir], { graceMs: 60000 })
    if (te.code !== 0) {
      rt.install = { phase: 'failed', pct: 0, message: '解压失败' }
      throw new Error('tar 解压失败: ' + clip(te.stderr, 300))
    }
    rmSync(tmp, { force: true })
    writeFileSync(config.installDir + '/manifest.json', JSON.stringify({
      version: PIN.version, asset: PIN.asset, url: PIN.url, sha256: PIN.sha256, installedAt: new Date().toISOString(),
    }, null, 2) + '\n')
    await ensureBuiltinWebBundles(config.installDir)
    rt.install = { phase: 'done', pct: 100, message: 'code-server ' + PIN.version + ' 安装完成' }
    rt.phase = 'stopped'
    return { mode: 'pinned', binary: bin }
  }

  // 内置扩展浏览器端资源自动补齐（修补 code-server 4.135.0 打包缺陷）。
  // 缺陷：该构建的 lib/vscode/extensions 不携带任何内置扩展的 dist/browser/**，
  // 浏览器端扩展宿主激活它们时 404（"Activating extension failed: Not Found"），
  // 导致 markdown 预览 not found / 黑屏以及 emmet、语言特性等 web 功能缺失
  // （同类问题 microsoft/vscode-remote-release#7163）。
  // 处理：检测“manifest 声明了 browser 入口但文件缺失”的内置扩展，从 vscode.dev
  // 官方 CDN（上游对应 commit 的交付物）逐文件补齐：
  //   - 跟随 bundle 相对 import 递归下载，保证 chunk 一并落位；
  //   - 个别文件在 CDN 以 gzip 原样下发（无 content-encoding 标注），按 magic bytes 解压；
  //   - installDir/web-bundles-patch.json 为幂等标记，成功后不再重复执行；
  //   - 失败仅记录日志/diag，不阻断 code-server 启动。
  // 补齐清单修订号：清单有增补时 +1，旧标记（无 revision / 小于该值）视为未完成、
  // 下次启动重新扫描下载；否则已写 done 的旧标记会永久跳过新增条目。
  const WEB_BUNDLE_REVISION = 2
  const WEB_BUNDLE_EXTRAS = {
    // 以下文件由扩展运行期 new Worker / importScripts 动态拉起，静态 import 解析扫不到，
    // 需要显式列出：markdown 的语言服务 worker，以及 json/css/html 语言服务的浏览器端 server
    // （三者缺失时 web 端报 "Client ... Language Server: connection to server is erroring"）。
    'markdown-language-features': ['dist/browser/serverWorkerMain.js'],
    'json-language-features': ['server/dist/browser/jsonServerMain.js'],
    'css-language-features': ['server/dist/browser/cssServerMain.js'],
    'html-language-features': ['server/dist/browser/htmlServerMain.js'],
  }

  async function ensureBuiltinWebBundles(installDir) {
    // installDir 是安装根（<install>），解压产物在其下的 <PIN.root>/；两种传法都兼容：
    // 已是 code-server 树根（含 lib/vscode）就直接用，否则补上 PIN.root 一层。
    // 旧实现直接拿 installDir 拼 lib/vscode，恒不存在 → 静默 return 0，自动补齐从未执行。
    const root = existsSync(installDir + '/lib/vscode') ? installDir : installDir + '/' + PIN.root
    const libDir = root + '/lib/vscode'
    const extRoot = libDir + '/extensions'
    if (!existsSync(extRoot + '/package.json')) return 0
    const marker = root + '/web-bundles-patch.json'
    try {
      const m = JSON.parse(readFileSync(marker, 'utf8'))
      if (m.done === true && m.vscodeCdnCommit === PIN.vscodeCdnCommit && (m.revision || 0) >= WEB_BUNDLE_REVISION) return 0
    } catch (e) { /* 无标记 → 首次执行 */ }

    const base = 'https://main.vscode-cdn.net/stable/' + PIN.vscodeCdnCommit + '/extensions/'
    const failures = []
    const queue = []
    const seen = new Set()
    let downloaded = 0

    const collect = (rel) => {
      const k = rel.replace(/^\.\//, '')
      if (seen.has(k) || seen.has(k + '.js')) return
      seen.add(k); seen.add(k + '.js')
      queue.push({ ext: k.slice(0, k.indexOf('/')), rel: k })
    }

    for (const d of readdirSync(extRoot)) {
      const mPath = extRoot + '/' + d + '/package.json'
      let pkg; try { pkg = JSON.parse(readFileSync(mPath, 'utf8')) } catch (e) { continue }
      if (!pkg.browser) continue
      const entryRel = String(pkg.browser).replace(/^\.\//, '')
      const list = [entryRel].concat(WEB_BUNDLE_EXTRAS[d] || [])
      for (const f of list) {
        const rel = f.replace(/^\.\//, '')
        const absJs = extRoot + '/' + d + '/' + (/\.(m?js)$/i.test(rel) ? rel : rel + '.js')
        const absRaw = extRoot + '/' + d + '/' + rel
        if (!existsSync(absJs) && !existsSync(absRaw)) collect(d + '/' + rel)
      }
    }

    async function fetchFile(rel) {
      let buf = null
      try {
        const r = await fetch(base + rel)
        if (r.ok) {
          buf = Buffer.from(await r.arrayBuffer())
          // 个别文件在 CDN 上以 gzip 原样下发（无 content-encoding 标注），按 magic bytes 解压
          if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf)
        } else if (r.status !== 404) {
          failures.push('HTTP ' + r.status + ' ' + rel)
        }
      } catch (e) { failures.push('ERR ' + rel + ' ' + errText(e)) }
      return buf
    }

    const t0 = Date.now()
    while (queue.length) {
      if (Date.now() - t0 > 180000) { failures.push('补齐总时长超限，终止'); break }
      const t = queue.shift()
      const key = t.ext + '/' + t.rel
      if (seen.has(key) || seen.has(key + '.js')) continue
      seen.add(key); seen.add(key + '.js')
      let buf = await fetchFile(key)
      let rel = key
      if (!buf) { rel = key + '.js'; buf = await fetchFile(rel) }
      if (!buf) continue
      const outAbs = extRoot + '/' + rel
      mkdirSync(outAbs.slice(0, outAbs.lastIndexOf('/')), { recursive: true })
      writeFileSync(outAbs, buf)
      downloaded += 1
      if (/\.(m?js)$/i.test(rel)) {
        let txt = ''
        try { txt = readFileSync(outAbs, 'utf8') } catch (e) { txt = '' }
        if (txt.length > 0 && txt.length < 5242880) {
          const re = /(?:from|import|import\()\s*["'](\.\.?\/[^"']+)["']/g
          let m
          while ((m = re.exec(txt))) {
            const dirPart = rel.slice(0, rel.lastIndexOf('/') + 1)
            const stack = []
            for (const seg of (dirPart + m[1]).split('/')) {
              if (seg === '.') continue
              else if (seg === '..') stack.pop()
              else if (seg) stack.push(seg)
            }
            const abs = stack.join('/')
            if (!abs) continue
            if (seen.has(abs) || seen.has(abs + '.js')) continue
            if (existsSync(extRoot + '/' + abs) || existsSync(extRoot + '/' + abs + '.js')) continue
            collect(abs)
          }
        }
      }
    }

    writeFileSync(marker, JSON.stringify({
      done: failures.length === 0, revision: WEB_BUNDLE_REVISION,
      vscodeCdnCommit: PIN.vscodeCdnCommit, files: downloaded,
      failures: failures.slice(0, 50), at: new Date().toISOString(),
    }, null, 2) + '\n')
    if (downloaded > 0 || failures.length > 0) {
      console.log('dsh-vscode-bridge: 内置扩展浏览器端资源补齐 downloaded=' + downloaded + ' failures=' + failures.length)
      if (failures.length > 0) console.error('dsh-vscode-bridge: 补齐失败(前 8): ' + failures.slice(0, 8).join(' | '))
   }
    return downloaded
  }

  async function probe(url) {
    try { const r = await sh(['curl', '-fsS', '-m', '3', url]); return r.code === 0 } catch (e) { return false }
  }

  function watchServer(handle) {
    handle.done.then((exit) => {
      if (rt.server !== handle) return
      drainTail()
      rt.server = undefined
      if (rt.intentRunning) {
        rt.phase = 'crashed'
        rt.lastError = 'code-server 进程退出 code=' + exit.exitCode + ' signal=' + exit.signal
        console.error('dsh-vscode-bridge: ' + rt.lastError)
        scheduleRestart()
      } else {
        rt.phase = 'stopped'
      }
    })
  }

  function scheduleRestart() {
    if (!rt.intentRunning) return
    if (rt.restarts >= 3) { rt.phase = 'degraded'; return }
    rt.restarts += 1
    ctx.timeout(2500 * rt.restarts).then(() => {
      if (rt.intentRunning) return startServer().catch((e) => { rt.lastError = errText(e) })
    }).catch(() => {})
  }

  async function startServer() {
    if (rt.phase === 'starting' || rt.phase === 'running') return
    rt.intentRunning = true
    rt.phase = 'starting'
    rt.lastError = ''
    try {
      const target = await ensureInstall()
      const dir = openDirOf(config)
      if (!dirExists(dir)) throw new Error('打开目录不存在: ' + dir)
      ensureDirs([config.dataDir + '/user-data', config.dataDir + '/extensions'])
      writeFileSync(config.dataDir + '/code-server.yaml', 'bind-addr: 127.0.0.1:' + config.port + '\nauth: none\ncert: false\n')
      const handle = sp.spawn({
        argv: [target.binary, '--config', config.dataDir + '/code-server.yaml', '--user-data-dir', config.dataDir + '/user-data', '--extensions-dir', config.dataDir + '/extensions', '--disable-telemetry', '--disable-update-check']
          .concat(config.extraArgs.map(String))
          .concat([dir]),
        cwd: dir,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 262144 } },
        graceMs: 15000,
      })
      rt.server = handle
      rt.diag = ''
      rt.stdoutOff = 0
      rt.stderrOff = 0
      rt.startedKey = startedKeyOf(config)
      watchServer(handle)
      let healthy = false
      for (let i = 0; i < 60; i++) {
        await ctx.timeout(1000)
        drainTail()
        if (rt.server !== handle) return
        if (await probe('http://127.0.0.1:' + config.port + '/healthz')) { healthy = true; break }
      }
      if (!healthy) {
        try { handle.terminate() } catch (e) {}
        rt.server = undefined
        rt.lastError = 'code-server 60s 内未通过 /healthz 健康检查。最近输出: ' + clip(rt.diag, 400)
        throw new Error(rt.lastError)
      }
      rt.phase = 'running'
      rt.startedAt = Date.now()
      rt.restarts = 0
      console.log('dsh-vscode-bridge: code-server 就绪 http://127.0.0.1:' + config.port)
    } catch (e) {
      rt.phase = 'stopped'
      rt.lastError = errText(e)
      throw e
    }
  }

  function validDirArg(v) {
    const s = String(v == null ? '' : v)
    if (s === '') return null
    try {
      if (s.charAt(0) !== '/' || !statSync(s).isDirectory()) return null
    } catch (e) { return null }
    return s.replace(/\/+$/, '') || '/'
  }

  function dirExists(p) {
    try { return statSync(p).isDirectory() } catch (e) { return false }
  }

  /** 生效的 VS Code 打开目录：跟随开启且 client 已上报会话 cwd 时用其值，否则用配置的 workspacePath。 */
  function openDirOf(cfg) {
    if (cfg.workspaceFollow !== false && rt.clientFolder) return rt.clientFolder
    return cfg.workspacePath
  }

  async function stopServer() {
    rt.intentRunning = false
    const h = rt.server
    if (!h) { rt.phase = 'stopped'; return }
    try { h.terminate() } catch (e) {}
    await h.waitForExit().catch(() => {})
    if (rt.server === h) { rt.server = undefined; rt.phase = 'stopped' }
  }

  function beginJob(fn) {
    if (job) return false
    job = fn().catch((e) => { rt.lastError = errText(e); console.error('dsh-vscode-bridge: 后台任务失败: ' + rt.lastError) }).then(() => { job = null })
    return true
  }

  function snapshot() {
    drainTail()
    return {
      ok: true,
      phase: rt.phase,
      pinned: { version: PIN.version, asset: PIN.asset, sha256: PIN.sha256, sizeBytes: PIN.size },
      config: JSON.parse(JSON.stringify(config)),
      openDir: openDirOf(config),
      server: rt.server ? { pid: rt.server.pid, port: config.port, url: 'http://127.0.0.1:' + config.port + '/', startedAt: rt.startedAt } : null,
      install: rt.install ? JSON.parse(JSON.stringify(rt.install)) : null,
      diag: rt.diag.slice(-1200),
      lastError: rt.lastError,
    }
  }

  function validConfig(next) {
    if (next.serverMode !== 'pinned' && next.serverMode !== 'custom') throw new Error('serverMode 只能是 pinned 或 custom')
    for (const f of ['customBinaryPath', 'workspacePath', 'installDir', 'dataDir', 'downloadDir']) {
      if (typeof next[f] !== 'string') throw new Error(f + ' 必须是字符串')
      if (next[f] !== '' && next[f].charAt(0) !== '/') throw new Error(f + ' 需为绝对路径')
    }
    for (const f of ['installDir', 'dataDir', 'downloadDir']) {
      if (next[f].indexOf(WORKSPACE) !== 0) throw new Error(f + ' 必须位于工作区 ' + WORKSPACE + ' 内')
    }
    const p = Math.floor(Number(next.port))
    if (!(p >= 1 && p <= 65535)) throw new Error('port 必须是 1-65535 的整数')
    next.port = p
    if (typeof next.autoStart !== 'boolean') next.autoStart = true
    if (!Array.isArray(next.extraArgs)) throw new Error('extraArgs 必须是字符串数组')
    next.extraArgs = next.extraArgs.map(String).map((s) => s.trim()).filter((s) => s.length > 0)
    for (const a of next.extraArgs) {
      if (RESERVED_FLAGS.indexOf(a) !== -1 || a.indexOf('\n') !== -1) throw new Error('extraArgs 不允许覆盖保留参数: ' + a)
    }
    if (String(next.workspacePath || '').trim() === '') next.workspacePath = WORKSPACE
    if (typeof next.customBinaryPath !== 'string') next.customBinaryPath = ''
    if (typeof next.themeFollow !== 'boolean') next.themeFollow = true
    if (typeof next.workspaceFollow !== 'boolean') next.workspaceFollow = true
    return next
  }

  function startedKeyOf(cfg) {
    return cfg.serverMode + ':' + (cfg.serverMode === 'custom' ? cfg.customBinaryPath : PIN.version)
      + ':' + cfg.port + ':' + cfg.workspacePath + ':' + cfg.dataDir
  }

  async function setConfig(patch) {
    readConfig()
    const prevKey = startedKeyOf(config)
    config = validConfig(Object.assign({}, config, patch))
    if (config.workspaceFollow === false) rt.clientFolder = null
    writeConfig()
    if (rt.server && prevKey !== startedKeyOf(config)) {
      await stopServer()
      if (config.autoStart) beginJob(() => startServer())
    }
    return snapshot()
  }

  async function control(args) {
    const act = args && args.action
    readConfig()
    // client 半区随每次 control 上报「当前会话所在空间」的目录；无效值静默忽略（回退 workspacePath）。
    const wanted = validDirArg(args && args.folder)
    if (wanted && wanted !== rt.clientFolder) {
      rt.clientFolder = wanted
      console.log('dsh-vscode-bridge: 打开目录跟随当前空间 → ' + wanted)
    }
    // client 解析 trace（session/workspace/none + 服务可用性）；仅记录变化，用于定位跟随未生效的原因。
    const dbg = args && args.spaceTrace
    if (typeof dbg === 'string' && dbg.length > 0 && dbg !== rt.lastSpaceTrace) {
      rt.lastSpaceTrace = dbg
      console.log('dsh-vscode-bridge: client 空间解析 trace: ' + dbg)
    }
    if (act === 'ensure') {
      if (rt.phase === 'running' || rt.phase === 'starting' || rt.phase === 'installing') { /* 已在进行中 */ }
      else if (rt.phase === 'crashed' || rt.phase === 'degraded') { await stopServer(); beginJob(() => startServer()) }
      else beginJob(async () => { await ensureInstall(); if (config.autoStart) await startServer() })
    } else if (act === 'install') {
      await stopServer()
      beginJob(async () => { await ensureInstall(); if (config.autoStart) await startServer() })
    } else if (act === 'start') {
      beginJob(() => startServer())
    } else if (act === 'stop') {
      await stopServer()
    } else if (act === 'restart') {
      await stopServer()
      beginJob(() => startServer())
    } else {
      throw new Error('未知 action: ' + String(act))
    }
    drainTail()
    return snapshot()
  }

  // ---------- 同源 HTTP RPC 面（/dsh-vscode/*） ----------
  function jsonOf(res, code, value) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let raw = ''
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > 1048576) { raw = ''; return }
        raw += c
      })
      req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch (e) { resolve({}) } })
      req.on('error', () => resolve({}))
    })
  }

  const routeHandler = async (req, res) => {
    let url = '/'
    try { url = new URL(req.url ?? '/', 'http://x').pathname } catch (e) {}
    try {
      if (url === '/dsh-vscode/status' && req.method === 'GET') return jsonOf(res, 200, snapshot())
      if (url === '/dsh-vscode/config' && req.method === 'GET') { readConfig(); return jsonOf(res, 200, JSON.parse(JSON.stringify(config))) }
      if (url === '/dsh-vscode/config' && req.method === 'POST') return jsonOf(res, 200, await setConfig((await readBody(req)).patch || {}))
      if (url === '/dsh-vscode/control' && req.method === 'POST') return jsonOf(res, 200, await control(await readBody(req)))
      if (url === '/dsh-vscode/theme' && req.method === 'POST') {
        const body = await readBody(req)
        readConfig()
        if (config.themeFollow === false) return jsonOf(res, 200, { ok: true, skipped: true })
        const settingsPath = config.dataDir + '/user-data/User/settings.json'
        let cur = {}
        try { cur = JSON.parse(readFileSync(settingsPath, 'utf8')) } catch (e) { cur = {} }
        const themeName = body && body.dark ? 'Default Dark Modern' : 'Default Light Modern'
        if (cur['workbench.colorTheme'] !== themeName) {
          cur['workbench.colorTheme'] = themeName
          mkdirSync(dirname(settingsPath), { recursive: true })
          writeFileSync(settingsPath, JSON.stringify(cur, null, 2) + '\n')
        }
        return jsonOf(res, 200, { ok: true, theme: themeName })
      }
      return jsonOf(res, 404, { error: 'unknown route: ' + url })
    } catch (e) {
      return jsonOf(res, 500, { error: errText(e) })
    }
  }
  ctx.effect(() => webServer.register({ kind: 'prefix', path: '/dsh-vscode', handler: routeHandler }), 'dsh-vscode-bridge: routes')

  readConfig()

  ctx.effect(() => async () => {
    rt.intentRunning = false
    const h = rt.server
    if (h) {
      try { h.terminate() } catch (e) {}
      await h.waitForExit().catch(() => {})
    }
  }, 'dsh-vscode-bridge: server lifecycle')
}