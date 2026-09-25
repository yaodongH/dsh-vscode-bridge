# dsh-vscode-bridge

在 DSH 中心区视图内嵌**固定版本** code-server（VS Code Web），支持安装扩展、浏览/编辑文件等
全部 code-server 能力；提供 pinned / 自定义二进制两种服务器来源、端口与目录配置、安装进度与热切换。

## 效果

DSH 会话页内嵌的 VS Code 页签（better-sidebar 右侧栏面板，不影响主界面交互）——左：DSH 工作区与会话；
右：内嵌 code-server，正在以并排视图渲染本插件 README 的 Markdown 预览：

![DSH 会话内嵌 VS Code 页签与 Markdown 预览](docs/screenshot-md-preview.png)

## 安装（零 dsh 代码改动，纯插件）

约定：`<dsh 仓库>` 指 deepseek-harness 代码目录；`<本插件目录>` 指本 README 所在的目录。

```bash
# 1) 进入 DSH 仓库
cd <dsh 仓库>
# 2) 安装插件包（将插件行追加进 profile 层栈）
pnpm dsh plugin --profile web add <本插件目录>/dsh-vscode-bridge-0.1.20.tgz
# 3) 重启 dsh web（脱离终端重启，日志落盘；参数为 dsh 仓库目录与工作区目录，缺省取当前目录）
bash <本插件目录>/scripts/restart-dsh-web.sh <dsh 仓库> <工作区>
```

`dsh plugin add` 会读取包内 `dsh.bundle.patch`（cordis.patch.yml），把插件行追加进 profile 层栈；
重启后生效。卸载：`pnpm dsh plugin --profile web remove dsh-vscode-bridge` + 重启。

### 从源码打包

需要 Node.js ≥ 20 与 pnpm（或用 `npm pack` 等价替换）。插件源码就在本目录：

- Host 半区（code-server 安装/补齐/生命周期/HTTP RPC 面）：`lib/index.js`
- Client 半区（better-sidebar 页签/中心区回退视图 + 设置页）：`lib/client-registry.js`、`lib/client.js`

修改源码后，在 `<本插件目录>` 下重新打包：

```bash
# 1) 发布新版本时先提升 version（如 0.1.11 → 0.1.12），可自动更新安装文件名
# 2) 按 package.json 的 files 白名单产出 tgz（含 lib、README、LICENSE、docs 效果图）
pnpm pack        # 产出 dsh-vscode-bridge-<version>.tgz
# 3) 用新生成的 tgz 按上面的「安装」步骤重装 + 重启 dsh web
```

`pnpm pack` 只收录 `files` 白名单内的文件（lib、README、LICENSE、docs 效果图、cordis.patch.yml、
dsh.plugin.json），仓库里的历史 tgz 与本机开发脚本不会被误打进去。

**0.1.8 内置扩展资源自动补齐**：code-server 4.135.0 官方 tarball 缺少全部内置扩展的浏览器端
bundle（`dist/browser/**`），导致 web 端 markdown 预览 not found / 黑屏、emmet 与各语言特性不可用。
本版本起，插件在安装/启动 code-server 前自动检测这一缺失并按 `PIN.vscodeCdnCommit`（当前
`08d4889f…`，即上游 VS Code 1.135.0）从 `main.vscode-cdn.net` 逐文件补齐，成功后写入
`installDir/web-bundles-patch.json` 幂等标记；补齐失败会在日志/diag 中提示且**不阻断启动**。

**0.1.9 打开目录跟随当前空间**：切换 DSH 空间后重开 VS Code，打开目录会定位到**当前会话
所在空间**的目录，不再停留在旧工作空间。原理：client 半区读取 DSH 会话列表里当前会话的
`cwd`（即所在空间的目录），iframe 以 `?folder=<该目录>` 打开，并随每次 control 上报给宿主；
宿主在启动/重启 code-server 时也采用该目录作为打开目录。可用设置页的「打开目录跟随当前空间」
开关关闭（关闭后固定用「工作区路径」）。

**0.1.10 跟随修复**：0.1.9 的 client 半区未在 `inject` 里声明 `sessions`/`workspaces`，cordis 的
服务解析对未声明名字不可见，导致目录跟随从未读取到会话 cwd（恒回退「工作区路径」）。本版本
显式声明这两个 client 服务（与 dsh-better-sidebar / ui-workspace 的做法一致），并增加第二解析
路径（`workspaces` 工作区记录的 `path`），两者都取不到时才回退；client 会把解析 trace 随
control 上报，宿主在 `~/.dsh/dsh-web.log` 记录 `client 空间解析 trace`，页签状态条在无法识别
当前空间时会显示「（未识别当前空间）」。

**0.1.11 入口修复**：web 端 client 的实际加载入口是 `package.json` `exports["./client"]` 指向的
`lib/client.js`，此前该文件是一份停在 8 月 29 日的旧快照，导致 0.1.9/0.1.10 对
`lib/client-registry.js` 的修改从未到达浏览器（表现为跟随完全不生效）。本版本起
`lib/client.js` 与 `lib/client-registry.js` 保持字节一致，且打包时由 `prepack` 钩子强制同步，
杜绝两个入口各自漂移。

**0.1.13 黑屏修复（keep-alive iframe 层叠级）**：在 DSH 原生右栏（better-sidebar 0.19+ / DSH
0.1.5 宿主）下表现为「code-server 进程与握手全部正常、状态条显示运行中，但 VS Code 页面一片黑」。
根因：保活 iframe 是 body 直挂的 `position:fixed` 浮层，其 z-index 必须盖过**包含舞台的整条
层叠链**；而 DSH 原生 tab 单元格（`div._tabCell_*`）是 **grid 子项且 z-index:10**——z-index 对
flex/grid 子项即使 `position:static` 也生效并创建层叠上下文，旧计算只认 `position!=static` 的
祖先，恒算出 z=1，iframe 被整个 tab 体压在下面（命中测试也只打到舞台，画面是舞台的 `#1e1e1e`
底色）。现按「定位元素**或** flex/grid 子项且 z-index 非 auto」计级（本例算得 z=11），并在每次
定位后做命中测试自愈：覆盖中心若被「包含舞台」的宿主层压住则逐级抬 z 重试（上限 2000），
不含舞台的真浮层（弹窗/下拉/菜单）不抢层。属纯 client 侧改动，重装 tgz 后**刷新浏览器即生效**
（无需重启 dsh web）。

**0.1.14 内置扩展补齐自愈（路径 bug + 语言服务 worker）**：0.1.8 的自动补齐从未真正执行过——
`ensureBuiltinWebBundles` 收到的是安装根 `<install>`，却直接拼 `<install>/lib/vscode`（真实树在
`<install>/code-server-4.135.0-linux-amd64/lib/vscode`），`extensions/package.json` 判定恒不成立、
静默 `return 0`，所以磁盘上也没有 `web-bundles-patch.json` 标记，安装树一直靠手工跑脚本补齐。
本版本起自动识别两种传参形态（缺 `lib/vscode` 时补上 `PIN.root` 一层）。同时补齐清单新增
json / css / html 语言服务的**浏览器端 server worker**（`server/dist/browser/*ServerMain.js`）——
它们由扩展运行期 `new Worker`/`importScripts` 动态拉起，静态 import 解析扫不到，之前既不在
`WEB_BUNDLE_EXTRAS` 也不在脚本清单里，web 端一打开就报
`Client JSON Language Server: connection to server is erroring ... failed to load`。
清单带 `revision` 修订号（当前 2）：增补条目后旧标记不会永久跳过，会重新扫描下载。

**0.1.15 主题跟随收敛（DSH 深色 / VS Code 浅色）**：code-server 的 workbench **只在启动时读取一次**
user settings，之后不再跟随文件变化，而旧实现只是"挂载时随手 POST 一次"，于是三处断点叠加：
① 推送与 iframe 启动并发，启动先读到旧值就永远停在旧主题（浅色），此后任何写入都无效；
② DSH 主题变化经 ctx 的 `theme/change` 事件发布（`ThemeRuntime` 并无 `subscribe` 方法，旧代码
`themeService.subscribe` 恒不成立），切换 DSH 主题从不触发推送；
③ 宿主 `writeFileSync` 直写 `settings.json`，workbench 启动时撕裂读到空/半截文件会解析失败、
回退 `prefers-color-scheme`（多为浅色）。现改为：**先推主题、POST 落盘后再启动 iframe**；推送值与
当前 workbench 启动值不一致时**重载保活 iframe** 强制重读（切换 DSH 主题即跟随，实测 2~3 秒收敛）；
`ctx.on('theme/change')` + 状态轮询零成本差值检查双通道跟随；取值显式 `preference`（dark/light）
优先、`system` 才按浏览器解析，避免多客户端互相覆盖；宿主改原子写（tmp+rename）并按
「忽略 `Default ` 前缀与大小写」比较（workbench 会把值规范化成当前构建的标签，如
`Default Dark Modern` → `Dark Modern`），不再重复改写。同属 client 侧改动，刷新浏览器生效。

**0.1.20 弹窗会话标题**：满池腾位弹窗的每个候选实例增加「会话：…」一行（该空间的会话展示名，
超过 2 个折叠为「等 N 个会话」），触发弹窗的描述行也带上当前会话标题——用户按会话判断踢谁，
不必反查目录归属。

**0.1.19 实例池（按 workspace 缓存 + 满池弹窗腾位）**：此前一个浏览器页签只有一个保活 iframe，
URL 绑定「当前会话空间」（`?folder=`），**跨 workspace 切换会话等于换 URL → 整页导航 → workbench
冷启动**，切回来再冷启动一次（同 workspace 因 URL 不变反而零重载）。本版本起按 **folder 建实例池**
（`Map<folder, inst>`，每个实例独立的 body 直挂浮层 + iframe）：
- 同空间会话互切：命中同一实例，零重载（未保留状态不丢）；
- 跨空间切换：池内有 → **秒切**（只切可见性与几何）；池内无且未满 → 新建实例（一次冷启动）；
- 池满（上限可配「实例池上限」，默认 2、1–8）→ **弹窗让用户选择要踢出的实例**（默认预选最近最少
  使用，可取消；取消则继续显示当前实例并提示）。被踢实例整体销毁（iframe 置 `about:blank`）  其未保存文件由 VS Code 自身的 hot-exit 保存、重开该目录可恢复。
失效与收敛：code-server 重启（`dshrun` 变）→ 整池重建；DSH 主题变化 → 池内所有已加载实例各自
重载收敛（`dshreload` 计数 per 实例）；上限下调 → 按最近使用自动 LRU 收缩（不弹窗）。
实例数即 workbench + 扩展宿主数量，建议 1–3。同属 client 侧改动，刷新浏览器生效
（`instancePoolSize` 校验在下次重启 dsh web 后生效，旧宿主下客户端按默认 2 兜底）。

- **隔离调试**：`DSH_VSCODE_BRIDGE_WORKSPACE` 环境变量可覆盖插件的工作区根（数据/安装/下载目录
  与 config.json 的锚点），供独立 profile/端口的调试实例使用，不与主实例共用 code-server 端口与数据。

## 功能入口

- **VS Code 页签**：优先呈现为 dsh-better-sidebar 右侧栏页签（如已安装该插件，不影响主界面交互），
  否则回退为中心区「VS Code」标签页；状态灯 / 当前打开目录 / 启动停止重启 / iframe 全幅嵌入；
  打开目录默认跟随当前会话所在 DSH 空间，切换空间后重开 VS Code 即定位到新空间目录。
  **按 workspace 缓存实例**（实例池，默认保留 2 个）：同空间会话互切、或切回之前开过的空间，
  都直接秒切到已存活实例、零重载；池满时弹窗选择要踢出的实例。
- **设置页**：侧栏齿轮 → 「VS Code Server」——serverMode（pinned/custom）、customBinaryPath、端口、
  打开目录跟随开关、工作区路径（跟随关闭时的默认打开目录）、实例池上限、安装/数据/下载目录、
  autoStart、附加参数；配置持久化于 `<工作区>/.dsh/vscode-bridge/config.json`。

## 依赖

- **DSH 运行时服务**：需要宿主提供 `timer`、`subprocess`、`webServer` 三个 cordis 服务
  （缺任一插件会在加载时显式报错）。
- **dsh-better-sidebar 插件（可选增强）**：如已安装，VS Code 优先以右侧栏页签呈现；
  未安装时自动回退中心区视图，本插件独立可用。
- **DSH client `sessions` 服务（软依赖）**：用于读取当前会话所在空间的目录以实现「打开目录跟随」；
  服务不可用或会话无 cwd 时自动回退「工作区路径」。
- **code-server v4.135.0（固化）**：首次「启动」时经 `curl` 自动下载约 224MB，sha256 固化校验，
  需要访问 `github.com/coder/code-server` releases；详见「固化版本」。
- **内置扩展浏览器端资源补齐**：需要访问 `main.vscode-cdn.net`（vscode.dev 官方 CDN），
  用于补齐该 code-server 构建缺失的内置扩展浏览器端 bundle，保证 web 端功能完整。
- **Node.js ≥ 20**（dsh web 进程运行环境），插件以 cordis function plugin 形式随宿主进程运行。
- 数据目录：`<工作区>/.dsh/vscode-bridge/`（install / data / downloads / manifest 与补齐标记）。

## 固化版本

coder/code-server **v4.135.0**（linux-amd64）
sha256 `300ef4e37e469e6368a4673c6a623e1c9ba8a34f42b394fb49c431a8900bc7d1`
首次「启动」时自动下载安装（约 224MB，安装于 `installDir`）；升级固化版本 = 发布新版 bundle。

## 架构

- Host 行（`lib/index.js`，cordis function plugin）：`subprocess` 驱动 code-server（仅回环 `127.0.0.1:<port>`、
  `--auth none`、`--config` 指向插件生成的 yaml），健康轮询与崩溃退避重启；同源 HTTP 面经 `webServer.register`
  暴露 `/dsh-vscode/*`（status/config/control，JSON）；安装前自动补齐内置扩展浏览器端资源。
- Client 模块（`lib/client-registry.js`）：优先注册为 better-sidebar 页签，否则中心区视图 + 设置页，
  15s→1.5s 状态轮询（仅订阅时），iframe 直连 code-server 回环地址；`?folder=` 打开**当前会话所在
  空间目录**：会话身份取 `uiSession.adapter.current` 的 binding key（视图侧 main 选择），并订阅
  `uiSession`/`sessions`/`workspaces` 快照，切换空间立即跟随；目录优先取会话头 `cwd`，其次取
  `workspaces.items` 中 `sessionIds` 含该会话的 `path`，都取不到才回退「工作区路径」；随 control
  上报宿主用于启动目录。**实例池（0.1.19-0.1.20）**：`Map<folder, inst>` 按 folder 缓存 keep-alive iframe
  （body 直挂 fixed 浮层，节点绝不移动），切空间只切换可见性与几何 → 池内秒切；池满弹窗选腾位；
  code-server 重启整池重建、主题变化全池重载收敛、上限下调按 LRU 收缩。
- 插件停止/卸载会树级终止 code-server 并撤销路由。

## 安全与治理

- code-server 仅绑定回环且 `--auth none`，不对外暴露；本插件在 DSH 原点的 `/dsh-vscode/*` 路由仅提供
  状态/配置/控制 JSON（与宿主同源，无鉴权，仅限本机使用——与 DSH web 本身的回环部署模型一致）。
- code-server 以用户自身权限直接读写文件系统，**不经过 DSH 审批沙箱**（等同本机 IDE 的用户操作）；
  模型侧文件写入仍走 DSH 工具与审批体系。

## 已知问题与修复（code-server 4.135.0）

- **缺陷**：该构建的 `lib/vscode/extensions` 缺少全部内置 web 扩展的浏览器端 bundle（`dist/browser/*`），
  属 code-server 打包缺陷（对照 [vscode-remote-release#7163](https://github.com/microsoft/vscode-remote-release/issues/7163)）。
  在 web 端打开 markdown 等文件时，内置扩展被路由到浏览器端扩展宿主 → 加载 `dist/browser/*` 404
  （服务端日志 `File not found`）→ `Activating extension failed: Not Found` → 命令与自定义编辑器未注册，
  表现为 `command 'markdown.showPreviewToSide' not found` 或 markdown 预览黑屏。
- **修复**：0.1.8 起插件在 code-server 安装/启动前自动补齐（见上方说明）；
  `scripts/fix-builtin-web-entries.mjs` 可独立重跑（CDN 补文件 + browser 字段恢复 + commit 归一化与
  一致性终检）：`node scripts/fix-builtin-web-entries.mjs <code-server安装目录>`。
  本机 4.135.0 安装树已于 2026-08-30 手工补齐并实测：webview 正常渲染预览；2026-09-21 重跑脚本
  修复了 commit 漂移（三处归一为 `-fix2`）并清理了 catalog 历史重复字段（见下两条）。
- **浏览器强缓存**：code-server 对静态前端包下发 `Cache-Control: public, max-age=31536000`
  （一年、无 ETag），同 URL 覆盖文件后普通刷新拿不到新包。做法是把三处 `commit` 归一化为
  `de89acb…-fix2`（`product.json` + 两个前端包内嵌的编译期 `product.commit`）并重启 code-server，
  静态前缀变为 `stable-…-fix2`，浏览器整体重新拉取；刷新浏览器页面即生效。
- **三处 commit 必须一致，否则 web 端握手失败**：服务端在握手第 2 步比较 `product.json` 的 `commit`
  与客户端 bundle 内编译期 `product.commit`，不等即拒连，服务端日志
  `Client refused: version mismatch.`；表现为扩展宿主与管理连接全部建立不起来（内置扩展、markdown
  预览、语言特性全废，session 日志目录下不生成 `exthost*`）。脚本 C 步已改为**幂等归一化**
  （把 `BASE_COMMIT` 后的任意历史后缀统一改写为目标后缀，不再 `split/join` 追加——旧写法每跑一次
  就多一个 `-fix1`，正是 `-fix1-fix1-fix1` 漂移的来源），并在 D 步做三处一致性终检，不一致直接
  `exit 1`。需要新的缓存前缀时改 `COMMIT_SUFFIX` 后重跑脚本 + 重启 code-server。
- **catalog browser 字段的幂等**：脚本 B 步往 workbench 内联 catalog 补 `browser` 字段时，旧守卫用
  `seg.includes('browser:')` 判重，只认无引号的 JS 键写法，认不出自己写入的 `"browser":`，于是**每运行
  一次就给 19 个条目各追加一份**（本机累积到每个前端包 171 份、152 份冗余）。现改为按写入的 marker
  精确识别并把历史重复**收敛为恰好一份**（插在第一个 `main:"…"` 之后），条目判定与补写位置不变。
  2026-09-21 已清理 304 处重复；脚本现可反复运行，两次运行后三个文件内容零变化。
- **打开目录跟随失效（2026-09-21 修复）**：client 曾用 `sessions.list.getSnapshot().current` 取当前会话，
  但 DSH client 重构后 `SessionListState` 只保留 `ids/byId/phase`（导航归视图侧所有），该字段恒为
  `undefined` → 解析恒失败 → 恒回退 `workspacePath`，表现为「换空间后 VS Code 仍打开固定工作区」，
  宿主日志 `client 空间解析 trace: none(S1,W1)`。现改取 `uiSession.adapter.current` 的 binding key
  （并以 `localStorage['dsh.sessions.current']` 兜底），并新增 `subscribeSpaceDir` 订阅
  `uiSession`/`sessions`/`workspaces`，使切换空间时目录即时更新（不再依赖状态轮询重渲染）。
  trace 形如 `session(C1:ui,S1,W1)`；`none(...)` 表示仍未识别到空间。
- **keep-alive iframe 被 tab 体压住 → 全黑（2026-09-25 修复）**：症状为状态条正常、code-server
  握手与扩展宿主全部正常，但 VS Code 画面一片黑；`document.elementFromPoint(覆盖中心)` 打到
  `.dshvs-stage` 而非 iframe。判据是宿主 tab 单元格 `div._tabCell_*` 的 `z-index`（grid 子项，
  z-index 对 flex/grid 子项即使 `position:static` 也生效）。详见上方 0.1.13 说明；同类复发时
  先做命中测试，再看 `showIdeOver` 的 z 计级。
- 遗留噪音：`node_modules/vsda/rust/web/*` 404（官方私有授权 shim，vscode.dev 亦不公开托管），
  仅影响日志干净度；「Build with Agent」面板的 GitHub 登录超时属同源限制，不影响编辑与预览。
- 若未来更换固化版本（更新 PIN 重新下载 code-server）后再次出现同类问题，重跑该脚本 + 重启即可。

## License

[MIT](./LICENSE)