#!/usr/bin/env python3
"""KnowLattice local static server (macOS / Linux).

行为与 Windows 版 server.ps1 逐条对齐，两个平台不能有两套逻辑：

  * 只监听 127.0.0.1（回环），不暴露到局域网；
  * 同一张 MIME 表（关键是 .wasm -> application/wasm，否则浏览器拒绝流式编译）；
  * 无扩展名的路径回退到 index.html（应用是单页路由）；
  * 「端口即笔记库」：IndexedDB/localStorage 按 origin 隔离，8790 和 8791 是两个网站、
    两个库。所以启动前先探测端口段里有没有已经开着的 KnowLattice——有就直接打开它，
    而不是另起一个空库让用户以为笔记丢了；
  * 浏览器随时会中断连接（取消的 preconnect、页面跳转、取消的懒加载 chunk），
    这类异常绝不能把服务搞死——否则窗口还在、页面全是 Failed to fetch。

为什么不直接用 python3 -m http.server：上面第 2、3、4 条内置 server 都做不到
（它不认识 .wasm、不会 SPA 回退、也没有端口复用策略），所以自己写一个。

零依赖，只用标准库。用法：
    python3 server.py [--root <目录>] [--port 8790] [--no-browser]
"""

import argparse
import os
import re
import socket
import sys
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT_RANGE = 40  # 从首选端口往后试多少个
DEFAULT_PORT = 8790

# 与 server.ps1 的 $Mime 完全一致
MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.bmp': 'image/bmp',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.gz': 'application/gzip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

GREEN = '\033[32m'
YELLOW = '\033[33m'
DIM = '\033[90m'
RED = '\033[31m'
RESET = '\033[0m'

ROOT = ''  # main() 里设定


def mime_for(full: str) -> str:
    ctype = MIME.get(os.path.splitext(full)[1].lower())
    if not ctype:
        # LICENSE / COPYING / NOTICE / README 没有扩展名：按纯文本发，别让浏览器下载
        stem = os.path.splitext(os.path.basename(full))[0]
        if re.match(r'^(LICENSE|COPYING|NOTICE|README)$', stem, re.IGNORECASE):
            ctype = 'text/plain; charset=utf-8'
    return ctype or 'application/octet-stream'


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'  # 与 PS1 一致：一个连接一个请求，Connection: close
    server_version = 'KnowLattice'
    sys_version = ''

    def log_message(self, fmt, *args):  # 默认会往 stderr 刷每一行请求，这里静音
        pass

    def do_GET(self):
        self._serve(head=False)

    def do_HEAD(self):
        self._serve(head=True)

    def _send_text(self, status, text):
        body = text.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)

    def _serve(self, head):
        try:
            path = urllib.parse.unquote(self.path.split('?', 1)[0])
            if not path or path == '/':
                path = '/index.html'
            rel = path.lstrip('/')

            # 目录穿越防护：解析成真实路径后必须仍在 ROOT 之内
            full = os.path.realpath(os.path.join(ROOT, rel.replace('/', os.sep)))
            if full != ROOT and not full.startswith(ROOT + os.sep):
                self._send_text(403, 'forbidden')
                return

            if os.path.isdir(full):
                full = os.path.join(full, 'index.html')
            if not os.path.isfile(full):
                # 无扩展名的路径当单页路由处理，回退到 index.html
                if not re.search(r'\.[A-Za-z0-9]+$', path):
                    full = os.path.join(ROOT, 'index.html')
                else:
                    self._send_text(404, 'not found: ' + path)
                    return

            with open(full, 'rb') as fh:
                data = fh.read()

            self.send_response(200)
            self.send_header('Content-Type', mime_for(full))
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            if not head and data:
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # 浏览器中断连接是常态，不是错误
        except Exception as exc:  # noqa: BLE001 - 单个请求的任何意外都不该杀掉服务
            print(f'  [warn] request failed, still serving: {exc}', file=sys.stderr)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    # SO_REUSEADDR 在 POSIX 上是"重用 TIME_WAIT 端口"（关掉窗口再启动能立刻回到 8790，
    # 不然会漂到 8791 = 另一个 origin = 用户看到空库），必须开。
    # 但在 Windows 上它允许抢占别的程序正在监听的端口：绑定会"成功"，连接却仍进别人手里，
    # 表现就是服务在跑、浏览器打到别的程序上。所以 Windows 上关掉，让 bind 老实失败，
    # 走"端口被占 → 换端口 + 黄色警告"那条路（与 server.ps1 的行为一致）。
    allow_reuse_address = os.name != 'nt'

    def handle_error(self, request, client_address):
        # 默认实现会把 traceback 打到终端；浏览器中断连接时会刷屏，这里降级成一行
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        print(f'  [warn] connection error, still serving: {exc}', file=sys.stderr)


def probe(port: int) -> bool:
    """该端口上是不是已经有一个 KnowLattice 在应答（不是"有没有监听"）。

    超时给得很短：loopback 上的 KnowLattice 几毫秒就回话，而 40 个端口全探一遍，
    每个端口最多等这么久——万一某个端口被人绑了却不 accept（连接会卡在 SYN_SENT），
    给 2 秒就会让启动白等一分多钟。
    """
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.25) as sock:
            sock.settimeout(0.5)
            req = b'GET /index.html HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
            sock.sendall(req)
            buf = b''
            while len(buf) < 8192:
                chunk = sock.recv(8192)
                if not chunk:
                    break
                buf += chunk
                if b'KnowLattice' in buf:
                    break
            return b'KnowLattice' in buf
    except OSError:
        return False


def pause(msg='Press Enter to exit'):
    """出错时别让窗口一闪就没（对应 .bat 的 pause / PS1 的 Read-Host）。"""
    try:
        if sys.stdin and sys.stdin.isatty():
            input(msg)
    except (EOFError, KeyboardInterrupt):
        pass


def main() -> int:
    global ROOT
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--root', default=None, help='要发布的目录（默认脚本旁边的 app/）')
    ap.add_argument('--port', type=int, default=DEFAULT_PORT)
    ap.add_argument('--no-browser', action='store_true')
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.realpath(args.root or os.path.join(here, 'app'))
    if not os.path.isdir(root):
        print(f'{RED}App folder not found: {root}{RESET}')
        pause()
        return 1
    if not os.path.isfile(os.path.join(root, 'index.html')):
        print(f'{RED}index.html not found under: {root}{RESET}')
        pause()
        return 1
    ROOT = root

    # --- 端口策略：先看有没有已经开着的 KnowLattice，有就打开它 -----------------
    for port in range(args.port, args.port + PORT_RANGE):
        if probe(port):
            url = f'http://127.0.0.1:{port}/'
            print()
            print(f'  {GREEN}KnowLattice is already running at  {url}{RESET}')
            print(f'  {DIM}Opening that copy: notes are stored per address, so that is where{RESET}')
            print(f'  {DIM}your notes are. (Just unpacked a newer version? Close that window,{RESET}')
            print(f'  {DIM}then start again to run the new one.){RESET}')
            print()
            if not args.no_browser:
                try:
                    webbrowser.open(url)
                except Exception:  # noqa: BLE001
                    pass
            return 0

    httpd = None
    port = args.port
    for candidate in range(args.port, args.port + PORT_RANGE):
        try:
            httpd = Server(('127.0.0.1', candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if httpd is None:
        print(f'{RED}No free port available (tried {PORT_RANGE} ports).{RESET}')
        pause()
        return 1

    if port != DEFAULT_PORT:
        print()
        print(f'  {YELLOW}WARNING: port {DEFAULT_PORT} is taken by another program; using {port}.{RESET}')
        print(f'  {YELLOW}Notes are stored per address, so this address starts with its own empty vault:{RESET}')
        print(f'  {YELLOW}  http://127.0.0.1:{port}/   is NOT the same site as   http://127.0.0.1:{DEFAULT_PORT}/{RESET}')
        print(f'  {YELLOW}Close whatever holds {DEFAULT_PORT} and start again to get your notes back.{RESET}')

    url = f'http://127.0.0.1:{port}/'
    print()
    print(f'  {GREEN}KnowLattice is running at  {url}{RESET}')
    print(f'  {DIM}Keep this window open while using the app.{RESET}')
    print(f'  {DIM}Close this window to stop the server.{RESET}')
    print()
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n  Server stopped.')
    except Exception as exc:  # noqa: BLE001 - 对应 PS1 的 trap：留一条能看懂的话在屏幕上
        print()
        print(f'{RED}  Server stopped: {exc}{RESET}')
        print(f'{YELLOW}  The page already open in your browser can no longer load anything;{RESET}')
        print(f'{YELLOW}  it will report "Failed to fetch". Close that tab, then start again.{RESET}')
        print(f'{YELLOW}  Your notes are still there.{RESET}')
        print()
        pause()
        return 1
    finally:
        httpd.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
