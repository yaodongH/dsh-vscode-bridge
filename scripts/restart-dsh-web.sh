#!/usr/bin/env bash
# 重启 dsh web（在用户终端执行；本脚本脱离终端重启，日志落盘）
#
# 用法:
#   bash scripts/restart-dsh-web.sh [dsh仓库目录] [工作区目录]
#   或: DSH_REPO=<dsh仓库目录> WORKSPACE=<工作区目录> bash scripts/restart-dsh-web.sh
#
# 参数说明:
#   dsh仓库目录  运行 `pnpm dsh web` 的 deepseek-harness 代码目录（缺省取当前目录）
#   工作区目录    插件数据 <工作区>/.dsh/vscode-bridge 所在目录（缺省取当前目录）
#   环境变量: DSH_WEB_PORT（dsh web 端口，缺省 3080）、DSH_WEB_LOG（日志路径，缺省 ~/.dsh/dsh-web.log）
#
# 2026-08-29 修复：旧 dsh web 被杀后，其 code-server 子进程会被 init 收养成为孤儿、
# 继续占住 vscode-bridge 配置端口（默认 18643），导致新实例插件 spawn code-server
# 时报 EADDRINUSE 退出 code=1。因此这里除 3080 外也一并清理孤儿 code-server。
set -u

DSH_REPO=${1:-${DSH_REPO:-$PWD}}
WORKSPACE=${2:-${WORKSPACE:-$PWD}}
WEB_PORT=${DSH_WEB_PORT:-3080}
LOG_FILE=${DSH_WEB_LOG:-"$HOME/.dsh/dsh-web.log"}

if [ ! -f "$DSH_REPO/package.json" ]; then
  echo "错误: 找不到 dsh 仓库（$DSH_REPO/package.json 不存在）" >&2
  echo "用法: bash scripts/restart-dsh-web.sh [dsh仓库目录] [工作区目录]" >&2
  exit 2
fi

VS_BASE="$WORKSPACE/.dsh/vscode-bridge"
CS_PORT=$(grep -oP '"port"\s*:\s*\K[0-9]+' "$VS_BASE/config.json" 2>/dev/null || true)
[ -n "$CS_PORT" ] && echo "vscode-bridge 配置端口: $CS_PORT"

echo "[1/4] 停止旧 dsh web 进程与孤儿 code-server…"
fuser -k "$WEB_PORT/tcp" 2>/dev/null || true
pkill -f "pnpm dsh web" 2>/dev/null || true
# 清理被 init 收养的孤儿 code-server（模式取安装目录路径，不会匹配本脚本自身命令行）
pkill -f "dsh-vscode-bridge/install/code-server" 2>/dev/null || true
if [ -n "$CS_PORT" ]; then
  fuser -k "$CS_PORT/tcp" 2>/dev/null || true
fi
sleep 3

echo "[2/4] 等待端口 $WEB_PORT 与 code-server 端口释放…"
for i in $(seq 1 20); do
  web_up=false; cs_up=false
  curl -s -m 1 "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 && web_up=true
  [ -n "$CS_PORT" ] && curl -s -m 1 "http://127.0.0.1:$CS_PORT/healthz" >/dev/null 2>&1 && cs_up=true
  if ! $web_up && ! $cs_up; then
    echo "      端口已释放（${i}s）"
    break
  fi
  sleep 1
done

echo "[3/4] 重新启动 dsh web（nohup 脱离终端，日志 $LOG_FILE）…"
cd "$DSH_REPO" || exit 1
nohup pnpm dsh web > "$LOG_FILE" 2>&1 &
echo "      已启动 pid=$!"

echo "[4/4] 等待服务就绪…"
for i in $(seq 1 60); do
  code=$(curl -s -m 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/" 2>/dev/null || true)
  if [ "$code" = "401" ] || [ "$code" = "200" ]; then
    echo "      dsh web 已就绪（HTTP $code，${i}s）"
    # code-server 由插件异步拉起，顺带报告一次状态
    if [ -n "$CS_PORT" ]; then
      cscode=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CS_PORT/healthz" 2>/dev/null || true)
      if [ "$cscode" = "200" ]; then
        echo "      vscode-bridge code-server 已就绪（$CS_PORT）"
      else
        echo "      code-server 尚未就绪（HTTP $cscode），稍后可在页面上点「启动」或查看 $LOG_FILE"
      fi
    fi
    echo "完成。现在刷新浏览器，从会话列表恢复本会话即可。"
    exit 0
  fi
  sleep 1
done
echo "警告：60s 内未就绪，请查看 $LOG_FILE"
exit 1
