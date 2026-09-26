# dsh-vscode-bridge 0.1.22 e2e 验证报告 —— 信任打开的目录（禁用 Restricted Mode）+ 专注布局回归

- **被测版本**：`dsh-vscode-bridge@0.1.22`（`feat/focus-layout` 分支；在 0.1.21 专注布局之上新增信任目录能力，
  并对专注布局全量回归）
- **验证环境**（按工作区规则 1，全程隔离调试实例，未触碰 3080 主实例与其 code-server 18644）：
  - `DSH_HOME=/tmp/dsh-dev-home`、`DSH_VSCODE_BRIDGE_WORKSPACE=/tmp/dsh-dev-ws`、
    `dsh web --profile web --no-open --port 3190`（code-server 18654）
  - 同装 `dsh-better-sidebar@0.21.0`；code-server 安装树与扩展（openai.chatgpt / rust-analyzer）从主实例只读复制
  - 测试空间：`/tmp/dsh-dev-ws/spaces/{alpha,beta,gamma,delta}`；e2e 开头自动重置（停 code-server →
    清 user-data → config 复位 focusLayout/trustWorkspace=true、池上限 8 → ensure 启动）
- **驱动方式**：Playwright 真实浏览器 + iframe 内 workbench 布局探针（根容器类名 + `.part.*` 几何）+
  settings.json 落盘内容断言 + workbench 文本断言（Restricted Mode 横幅存在性）。
- **结果**：**21/21 断言通过**（原始记录：[e2e-results-0.1.22.json](./e2e-results-0.1.22.json)）

## 0.1.22 新增实现

- 宿主（`lib/index.js`）：配置项 `trustWorkspace`（默认 true，持久化 config.json）；`POST /dsh-vscode/layout`
  键组泛化——`trustWorkspace !== false` 时**恒写** `security.workspace.trust.enabled: false`（键名已在
  code-server 4.135.0 安装树 `lib/vscode/out/` 中核实存在）；focus 三键（0.1.21）照旧随 `{focus}` 写/删；
  幂等比较 + tmp/rename 原子写；focus 缺参/非布尔返回 400。
- 客户端（`lib/client-registry.js`）：`pushLayout` 差值从「仅 focus」扩展为「focus + trust」；
  设置页新增「信任打开的目录（关闭 Restricted Mode）」勾选框（默认勾选）。
- **动机**：Restricted Mode（工作区信任横幅「Restricted Mode is intended for safe code browsing…」）下
  **Codex 等扩展被禁用**；桥只会打开本机 DSH 空间目录（用户自选路径），默认信任是合理基线。
  关闭开关则移除该键、恢复 VS Code 默认信任行为。

## 验证点与现场证据

| # | 验证点 | 结果 |
| --- | --- | --- |
| V1 | 全新空间 alpha 首开：主边栏/编辑器区/面板收起、状态栏隐藏、**活动栏保留**、副边栏最大化占满 | 6/6 PASS |
| V1 | **无 Restricted Mode 信任横幅**（frame 文本断言 absent）+ **四键落盘**（三键 + `security.workspace.trust.enabled=false`） | 2/2 PASS |
| V2 | 显式打开主边栏 → 解除最大化（编辑器区还原）；**重载后保留用户布局**（不被强拉）；状态栏仍隐藏 | 3/3 PASS |
| V3 | 全新空间 beta → 新实例自动进专注 | PASS |
| V4 | 关闭「专注布局」→ 收敛重载：alpha 状态栏恢复且保留用户布局；beta **保持专注**（wasLastMaximized 已持久化）；**focus 三键移除、trust 键保留**；gamma 全新空间不自动最大化、状态栏可见 | 6/6 PASS |
| V5 | 重新开启 → delta 全新空间再次进专注、四键重新落盘 | 2/2 PASS |
| V6 | 设置页「专注布局」勾选框存在且状态与配置一致（只读检查） | PASS |

首开即专注、无信任横幅、Codex 可用（本次 CHAT/CODEX 两个容器页签均正常呈现）：

![01 alpha 首开即专注且无信任横幅](./01-focus-alpha.png)

显式打开主边栏解除最大化（重载后保留该布局）：

![04 重载后保留用户布局](./04-reload-keeps-user-layout.png)

## 复跑方式

```bash
cd <本插件目录> && ln -sfn ../DSH-better-sidebar/node_modules node_modules
DSH_URL='http://127.0.0.1:3190/?token=<一次性启动 token>' node demo/e2e-focus-layout.mjs
# 隔离实例启动：
cd <dsh 仓库> && DSH_HOME=/tmp/dsh-dev-home DSH_VSCODE_BRIDGE_WORKSPACE=/tmp/dsh-dev-ws \
  node apps/cli/lib/bin.js --profile web --no-open --port 3190
```

## 说明与边界

- 0.1.21 的验证记录见 [e2e-report-0.1.21.md](./e2e-report-0.1.21.md)；本轮 01–09 截图为 0.1.22 重跑
  产物（覆盖同名文件，均为无横幅版本）。
- `security.workspace.trust.enabled: false` 会全局禁用信任门（对 code-server 内手动打开的任意目录同样生效）；
  如需恢复，在设置页关闭「信任打开的目录」并重载实例即可。
- 专注布局的既有边界（本功能启用前已打开过的 folder 需点一次副边栏「最大化」持久化；新空间首开默认
  容器可能非 CODEX，点一次标签即持久化）与 0.1.21 相同，未变化。