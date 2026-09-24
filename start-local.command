#!/bin/bash
# 演出用本地版：在本机起一个静态服务打开这个仓库，全程不依赖外网。
#
# 双击本文件即可（第一次可能需要：chmod +x start-local.command）。
# 关掉这个终端窗口就会停止本地服务。
#
# 行为：
#   1) 先尽力从 GitHub 同步一次（没网/失败都不影响启动，直接用本地版本）
#   2) 在本机起 python3 的静态服务（默认 8899 端口，被占用就往后找）
#   3) 用「关闭窗口遮挡检测」的 Chrome 打开本地地址（OBS 抓窗口长时间不断流）
set -u

cd "$(dirname "$0")" || exit 1
ROOT="$PWD"

# ---------- 1) 尽力同步线上版本 ----------
if command -v git >/dev/null 2>&1; then
  echo "== 尝试同步 GitHub 最新版本（离线会自动跳过）=="
  if git -c http.version=HTTP/1.1 pull --ff-only --quiet 2>/dev/null; then
    echo "   已是最新：$(git log --oneline -1)"
  else
    echo "   同步失败（可能没网），用本地当前版本：$(git log --oneline -1)"
  fi
fi

# ---------- 2) 起本地服务 ----------
if ! command -v python3 >/dev/null 2>&1; then
  echo "找不到 python3，无法启动本地服务。请先安装 macOS 命令行工具：xcode-select --install"
  read -r -p "按回车键退出…" _
  exit 1
fi

PORT=8899
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done
URL="http://127.0.0.1:$PORT/"

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >/tmp/aoyu-local-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT INT TERM

for _ in $(seq 1 40); do
  if curl -sS -m 1 -o /dev/null "$URL"; then break; fi
  sleep 0.25
done

if ! curl -sS -m 2 -o /dev/null "$URL"; then
  echo "本地服务没起来，日志：/tmp/aoyu-local-server.log"
  read -r -p "按回车键退出…" _
  exit 1
fi

echo "== 本地地址：$URL （服务器日志：/tmp/aoyu-local-server.log）=="

# ---------- 3) 用关闭遮挡检测的 Chrome 打开 ----------
if [ -x "tools/launch-chrome-aoyuar.command" ]; then
  bash tools/launch-chrome-aoyuar.command "$URL"
else
  open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
fi

echo
echo "本地版正在运行。演出结束后关掉这个窗口（或按 Control-C）即可停止服务。"
wait "$SERVER_PID"
