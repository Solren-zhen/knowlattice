#!/usr/bin/env bash
# 从 01-原始安装包/ 里的四个 APK 重建 02-解包副本/（content-packs/tools/build_packs.py --src 认的布局）。
# 归档根默认 ~/Desktop/晶格个人资料，可用环境变量 JINGGE_DATA 覆盖。
# 提取逻辑在 unpack.py（python zipfile；Git Bash 里没有 unzip，且只抽需要的段）。
#
# 用法：bash med-archive/tools/unpack.sh [输出目录]
#       不带参数重建 02-解包副本/；带临时目录可做完整性比对。
set -euo pipefail
cd "$(dirname "$0")/.."

PY=""
for c in "$HOME/.local/bin/python3.11.exe" \
         "$HOME/AppData/Roaming/uv/python/cpython-3.11.15-windows-x86_64-none/python.exe" \
         python3.11 python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  if [ -f "$c" ]; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "找不到 python3.11（bash 里的 python 是 WindowsApps 存根）" >&2; exit 1; }
export PYTHONIOENCODING=utf-8

exec "$PY" tools/unpack.py "${1:-}"
