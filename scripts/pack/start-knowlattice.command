#!/bin/bash
# KnowLattice 启动入口（macOS / Linux）
#
# 双击即可（macOS 会把 .command 交给「终端」执行）。也可以：
#     bash start-knowlattice.command
#
# 只做两件事：找一个能用的 Python 3，然后交给同目录的 server.py。
# 本机服务只监听 127.0.0.1，不联网、不上传任何数据。

cd "$(dirname "$0")" || exit 1

PY=""
for candidate in python3 /usr/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    # macOS 自带的 /usr/bin/python3 只是个壳：没装 Xcode 命令行工具时它跑不起来。
    # 所以这里真的执行一次版本检查，而不是只看文件在不在。
    if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)' >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  fi
done

if [ -z "$PY" ]; then
  echo ""
  echo "  KnowLattice needs Python 3, and this Mac does not have a usable one yet."
  echo ""
  echo "  Install it with either of these (both are free, one-time):"
  echo "    1) open Terminal and run:   xcode-select --install"
  echo "    2) or install Homebrew, then run:   brew install python"
  echo ""
  echo "  Then double-click this file again."
  echo ""
  printf "Press Enter to close this window..."
  read -r _
  exit 1
fi

# -u：关掉 Python 的块缓冲。终端里本来就是行缓冲，但如果输出被重定向（有人从别的
# 脚本里调用它），不加这个的话「KnowLattice is running at …」会一直卡在缓冲区里，
# 用户对着一个看起来没反应的窗口干等。
exec "$PY" -u server.py "$@"
