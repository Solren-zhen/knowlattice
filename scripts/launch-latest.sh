#!/bin/sh
# 晶格 · KnowLattice 一键启动最新版
#
# 1) 每次启动都重新构建 dist，保证打开的一定是最新代码
# 2) 固定端口 5199 —— IndexedDB 按 origin 隔离，换端口会看不到原有笔记
# 3) 重启本地服务（先停掉旧进程，避免复用旧构建），再打开浏览器
#
# 用法：launch-latest.sh            构建 → 启动 → 打开浏览器
#       launch-latest.sh --check    同上但不打开浏览器，仅检查服务就绪（供调试）
#
# 退出码：0 成功；2 本次构建失败但用上次产物打开了；3 项目/依赖缺失；4 构建失败且无产物；5 服务启动超时

set -u

PROJ="/Users/jophy/Desktop/medvault-main"
PORT=5199
URL="http://localhost:$PORT/"
PIDFILE="/tmp/medvault-preview.pid"
BUILDLOG="/tmp/medvault-build.log"
SRVLOG="/tmp/medvault-preview.log"

# 优先用固定的 node，找不到再退回 PATH（避免双击启动时 PATH 不完整）
NODE="/Users/jophy/miniconda3/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "找不到 node，请确认 Node.js 已安装。" >&2
  exit 3
fi

cd "$PROJ" 2>/dev/null || { echo "找不到项目目录：$PROJ" >&2; exit 3; }
[ -f node_modules/vite/bin/vite.js ] || { echo "缺少依赖，请先在项目里执行 npm install。" >&2; exit 3; }

# ---------- 1) 构建最新版 ----------
# 源码/资源比 dist 新才重建：既保证打开的是最新版，重复启动又只需两三秒
NEEDS_BUILD=0
if [ ! -f dist/index.html ]; then
  NEEDS_BUILD=1
else
  NEWER="$(find src public index.html package.json vite.config.ts \
    tsconfig.json tsconfig.app.json tsconfig.node.json \
    -newer dist/index.html -print -quit 2>/dev/null)"
  [ -n "$NEWER" ] && NEEDS_BUILD=1
fi

BUILD_OK=1
if [ "$NEEDS_BUILD" = 1 ]; then
  : >"$BUILDLOG"
  if [ -f node_modules/typescript/bin/tsc ]; then
    "$NODE" node_modules/typescript/bin/tsc -b >>"$BUILDLOG" 2>&1 || BUILD_OK=0
  fi
  if [ "$BUILD_OK" = 1 ]; then
    "$NODE" node_modules/vite/bin/vite.js build >>"$BUILDLOG" 2>&1 || BUILD_OK=0
  fi
fi
if [ ! -f dist/index.html ]; then
  echo "构建失败，且没有可用的 dist/index.html。详情见 $BUILDLOG" >&2
  exit 4
fi

# ---------- 2) 停掉旧服务，确保不复用旧构建 ----------
if [ -f "$PIDFILE" ]; then
  OLD="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "$OLD" ] && kill "$OLD" 2>/dev/null
  rm -f "$PIDFILE"
fi
# 兜底：还有别的进程占着端口就一并停掉（仅限 vite 进程，避免误杀无关服务）
for pid in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null); do
  if ps -p "$pid" -o command= 2>/dev/null | grep -q "vite"; then
    kill "$pid" 2>/dev/null
  fi
done
sleep 1

# ---------- 3) 启动服务 ----------
: >"$SRVLOG"
nohup "$NODE" node_modules/vite/bin/vite.js preview --port "$PORT" --strictPort >>"$SRVLOG" 2>&1 &
echo $! >"$PIDFILE"

# ---------- 4) 等待就绪 ----------
i=0
while [ "$i" -lt 30 ]; do
  if curl -fs -o /dev/null "$URL" 2>/dev/null; then break; fi
  i=$((i + 1))
  sleep 0.5
done

if ! curl -fsS -o /dev/null "$URL"; then
  echo "本地服务启动超时。详情见 $SRVLOG" >&2
  exit 5
fi

if [ "${1:-}" = "--check" ]; then
  echo "READY $URL build_ok=$BUILD_OK rebuilt=$NEEDS_BUILD"
  [ "$BUILD_OK" = 1 ] && exit 0
  exit 2
fi

# 带时间戳打开，绕开浏览器对 index.html 的缓存（MEDVAULT_NO_OPEN=1 可跳过，供调试）
if [ "${MEDVAULT_NO_OPEN:-}" != "1" ]; then
  open "$URL?v=$(date +%s)"
fi
[ "$BUILD_OK" = 1 ] && exit 0
exit 2
