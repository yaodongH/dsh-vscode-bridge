// 修复 code-server 4.135.0 构建缺陷：lib/vscode/extensions 内置扩展缺少浏览器端 bundle
// （dist/browser/**），导致 web 扩展宿主激活时 404 → "Activating extension failed: Not Found"
// → markdown 预览命令 not found / 预览黑屏。
//
// 修复方式（对照 vscode.dev 官方 CDN 交付物）：
//   A) 从 CDN 下载缺失的 dist/browser/** 文件树（递归解析 bundle 相对 import；
//      注意个别文件以 gzip 原样下发，需按 magic bytes 解压）
//   B) 恢复磁盘 manifest 与 workbench 内联 catalog 中被误删的 browser 字段
//      （web 宿主据其寻址；没有 browser 字段的条目无法路由）——仅当缺失时恢复
//
// 运行方式：node scripts/fix-builtin-web-entries.mjs <code-server安装目录>
//   <code-server安装目录> 为 code-server-4.135.0-linux-amd64 解压目录（须含 lib/vscode/product.json），
//   也可用环境变量 CODE_SERVER_DIR 指定；脚本会 chdir 到其 lib/vscode 后执行。
// 生效方式：静态文件按请求读取，无需重启 code-server；浏览器端因静态资源带一年强缓存，
//          同 URL 覆盖不会生效——需配合"换端口"或"commit 后缀 + 重启 code-server"让浏览器重新拉取。
import fs from 'node:fs'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// ---- 可调参数 ----
const CDN = 'https://main.vscode-cdn.net/stable/08d4889f9ec4a1685d257b9b95de036c8e1ce1e5' // vscode.dev 官方 CDN（VS Code 1.135.0, commit 08d4889f）
const COMMIT_SUFFIX = '-fix2' // 归一化目标后缀：三处 commit 一律改写为 BASE_COMMIT + 该后缀（空串 = 去掉后缀）。
// 换一个值即可击穿浏览器对 static/** 的一年强缓存；改完需重启 code-server。

const installDir = process.argv[2] || process.env.CODE_SERVER_DIR
if (!installDir) {
  console.error('用法: node scripts/fix-builtin-web-entries.mjs <code-server安装目录>')
  console.error('      （或设置环境变量 CODE_SERVER_DIR；目录须含 lib/vscode/product.json）')
  process.exit(2)
}
const vscodeDir = join(installDir, 'lib', 'vscode')
if (!fs.existsSync(join(vscodeDir, 'product.json'))) {
  console.error('错误: 不是有效的 code-server 安装目录（缺 ' + join(vscodeDir, 'product.json') + '）')
  process.exit(2)
}
process.chdir(vscodeDir)
const EXT = 'extensions'
const BASE_COMMIT = 'de89acbcdce9d9b870008a270c9f6466993d91f4'

// 需要浏览器端 bundle 的内置扩展及其 browser 入口（与上游 1.135.0 一致）
const RESTORE = {
  'configuration-editing': './dist/browser/configurationEditingMain',
  'css-language-features': './client/dist/browser/cssClientMain',
  'emmet': './dist/browser/emmetBrowserMain',
  'extension-editing': './dist/browser/extensionEditingBrowserMain',
  'git-base': './dist/browser/extension.js',
  'github-authentication': './dist/browser/extension.js',
  'html-language-features': './client/dist/browser/htmlClientMain',
  'ipynb': './dist/browser/ipynbMain.browser.js',
  'json-language-features': './client/dist/browser/jsonClientMain',
  'markdown-language-features': './dist/browser/extension',
  'markdown-math': './dist/browser/extension',
  'media-preview': './dist/browser/extension.js',
  'merge-conflict': './dist/browser/mergeConflictMain',
  'mermaid-markdown-features': './dist/browser/extension',
  'npm': './dist/browser/npmBrowserMain',
  'references-view': './dist/browser/extension',
  'search-result': './dist/browser/extension',
  'simple-browser': './dist/browser/extension',
  'typescript-language-features': './dist/browser/extension',
}

const missingInTree = (rel) => !fs.existsSync(EXT + '/' + rel) && !fs.existsSync(EXT + '/' + rel + '.js')
const normalize = (base, rel) => {
  const parts = base.split('/'); parts.pop()
  for (const seg of rel.split('/')) {
    if (seg === '.') continue
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg)
  }
  return parts.join('/')
}

// ---- A. CDN 下载缺失的浏览器端文件树 ----
const failures = new Set()
let downloaded = 0
async function fetchOne(url) {
  try {
    const r = await fetch(url)
    if (!r.ok) { if (r.status !== 404) failures.add(url + ' → HTTP ' + r.status); return null }
    let buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) { buf = zlib.gunzipSync(buf) } // 个别文件 gzip 原样下发
    return buf
  } catch (e) { failures.add('ERR ' + url + ' → ' + e.message); return null }
}
const writeAt = (rel, buf) => {
  const parts = (EXT + '/' + rel).split('/'); parts.pop()
  fs.mkdirSync(parts.join('/'), { recursive: true })
  fs.writeFileSync(EXT + '/' + rel, buf)
}

// 运行期 new Worker / importScripts 动态拉起的 worker 入口：静态 import 解析扫不到，须显式列出。
// json/css/html 语言服务的浏览器端 server 缺失时，web 端报
// "Client ... Language Server: connection to server is erroring ... failed to load"。
const WORKER_EXTRAS = {
  'markdown-language-features': ['dist/browser/serverWorkerMain.js'],
  'json-language-features': ['server/dist/browser/jsonServerMain.js'],
  'css-language-features': ['server/dist/browser/cssServerMain.js'],
  'html-language-features': ['server/dist/browser/htmlServerMain.js'],
}

const queue = []
for (const [dir, bp] of Object.entries(RESTORE)) {
  const rel = bp.replace(/^\.\//, '')
  if (missingInTree(dir + '/' + rel)) queue.push({ dir, rel })
}
for (const [dir, files] of Object.entries(WORKER_EXTRAS)) {
  for (const f of files) {
    const rel = f.replace(/^\.\//, '')
    if (missingInTree(dir + '/' + rel)) queue.push({ dir, rel })
  }
}
console.log('CDN 待下载入口:', queue.length)
const seen = new Set()
while (queue.length) {
  const t = queue.shift()
  const id = t.dir + '/' + t.rel
  if (seen.has(id) || seen.has(id + '.js')) continue
  seen.add(id)
  if (!missingInTree(id)) continue
  let buf = await fetchOne(CDN + '/extensions/' + t.dir + '/' + t.rel)
  let rel = t.rel
  if (!buf) { rel = t.rel + '.js'; buf = await fetchOne(CDN + '/extensions/' + t.dir + '/' + rel) }
  if (!buf) continue
  writeAt(t.dir + '/' + rel, buf)
  downloaded++
  console.log('下载:', t.dir + '/' + rel, buf.length, 'bytes')
  if (/\.(m?js)$/i.test(rel)) {
    const txt = buf.toString('utf8')
    let m
    const re = /(?:from|import|import\()\s*["'](\.\.?\/[^"']+)["']/g
    while ((m = re.exec(txt))) {
      const abs = normalize(rel, m[1])
      if (!abs || seen.has(t.dir + '/' + abs)) continue
      if (!missingInTree(t.dir + '/' + abs)) continue
      queue.push({ dir: t.dir, rel: abs })
    }
  }
}
if (failures.size) { console.log('下载失败:'); for (const f of failures) console.log('  ' + f) }
console.log('CDN 下载文件数:', downloaded)

// ---- B. 恢复 browser 字段（磁盘 manifest + workbench 内联 catalog）----
for (const [dir, bp] of Object.entries(RESTORE)) {
  const path = EXT + '/' + dir + '/package.json'
  const p = JSON.parse(fs.readFileSync(path, 'utf8'))
  if (p.browser !== bp) { p.browser = bp; fs.writeFileSync(path, JSON.stringify(p)); console.log('manifest 恢复 browser:', dir) }
}
function restoreCatalogEntry(s, dir, bp) {
  const start = s.indexOf(`{extensionPath:"${dir}"`)
  if (start < 0) return { s, hit: false, removed: 0 }
  let end = s.indexOf('{extensionPath:"', start + 10)
  if (end < 0) end = s.length
  const seg = s.slice(start, end)
  const marker = ',"browser":"' + bp + '"'
  const copies = seg.split(marker).length - 1
  const m = seg.match(/main:"[^"]*"/)
  if (copies > 0) {
    // 本脚本已写入过：无论历史重复几次都收敛为恰好一份，固定插在第一个 main 之后。
    // 旧守卫只认无引号的 `browser:`，认不出自己写入的 `"browser":`，于是每运行一次就多追加一份。
    if (!m) return { s, hit: false, removed: 0 }
    const cleaned = seg.split(marker).join('').replace(/main:"[^"]*"/, m[0] + marker)
    const next = s.slice(0, start) + cleaned + s.slice(end)
    return { s: next, hit: next !== s, removed: copies - 1 }
  }
  // 从未写入过：保持原判定，仅在条目缺 browser 字段且带 main 时补一份
  if (seg.includes('browser:') || !m) return { s, hit: false, removed: 0 }
  const next = s.slice(0, start) + seg.replace(/main:"[^"]*"/, m[0] + marker) + s.slice(end)
  return { s: next, hit: next !== s, removed: 0 }
}
const bundles = ['out/vs/workbench/workbench.web.main.internal.js', 'out/vs/code/browser/workbench/workbench.js']
let catalogRemoved = 0
for (const file of bundles) {
  const before = fs.readFileSync(file, 'utf8')
  let s = before
  for (const [dir, bp] of Object.entries(RESTORE)) { const r = restoreCatalogEntry(s, dir, bp); s = r.s; catalogRemoved += r.removed }
  if (s === before) continue // 已恢复过：不重写 18MB 前端包，保持整脚本可重复执行
  fs.writeFileSync(file, s)
  try { execFileSync('node', ['--check', file]); } catch (e) { console.log('SYNTAX FAIL', file, e.message); process.exit(1) }
}
if (catalogRemoved > 0) console.log('catalog 历史重复 browser 字段收敛:', catalogRemoved, '处')
console.log('catalog/manifest browser 字段恢复 ✓')

// ---- C. commit 后缀归一化（缓存击穿；需重启 code-server 生效）----
// 幂等：BASE_COMMIT 后面的任意历史后缀（-fix1、-fix1-fix1…）一律改写为 BASE_COMMIT + COMMIT_SUFFIX。
// 服务端握手第 2 步比较 product.json 的 commit 与 web 客户端 bundle 内编译期 product.commit，
// 两者不等即拒连（日志 "Client refused: version mismatch."），因此三处必须始终一致。
const COMMIT_RE = new RegExp(BASE_COMMIT + '(?:-[0-9A-Za-z]+)*', 'g')
const TARGET_COMMIT = BASE_COMMIT + COMMIT_SUFFIX
const productJson = JSON.parse(fs.readFileSync('product.json', 'utf8'))
if (productJson.commit !== TARGET_COMMIT) {
  productJson.commit = TARGET_COMMIT
  fs.writeFileSync('product.json', JSON.stringify(productJson, null, 2))
}
for (const file of bundles) {
  const before = fs.readFileSync(file, 'utf8')
  const after = before.replace(COMMIT_RE, TARGET_COMMIT)
  if (after === before) continue
  fs.writeFileSync(file, after)
  try { execFileSync('node', ['--check', file]) } catch (e) { console.log('SYNTAX FAIL', file, e.message); process.exit(1) }
}
console.log('commit →', TARGET_COMMIT, '（重启 code-server 后生效；浏览器缓存整体失效）')

// ---- D. 一致性终检：三处 commit 必须完全相同（不等则 web 端必定握手失败）----
const commitSeen = new Map()
commitSeen.set('product.json', JSON.parse(fs.readFileSync('product.json', 'utf8')).commit)
for (const file of bundles) {
  const hits = [...new Set(fs.readFileSync(file, 'utf8').match(new RegExp(BASE_COMMIT + '(?:-[0-9A-Za-z]+)*', 'g')) || [])]
  commitSeen.set(file, hits.length === 1 ? hits[0] : '(' + (hits.join(' / ') || '未找到 BASE_COMMIT') + ')')
}
for (const [file, commit] of commitSeen) console.log('commit 校验:', file, '=', commit)
if (new Set(commitSeen.values()).size !== 1) {
  console.error('一致性校验失败：三处 commit 不一致 → 浏览器端会被拒连（Client refused: version mismatch.）')
  process.exit(1)
}

// ---- E. 补齐终检 ----
let leftover = 0
for (const [dir, bp] of Object.entries(RESTORE)) {
  const rel = bp.replace(/^\.\//, '')
  if (!fs.existsSync(EXT + '/' + dir + '/' + rel) && !fs.existsSync(EXT + '/' + dir + '/' + rel + '.js')) { leftover++; console.log('仍缺失:', dir, bp) }
}
console.log(leftover === 0 ? '全部就位 ✓ 刷新浏览器页面即可生效' : '仍有缺失 ' + leftover)
