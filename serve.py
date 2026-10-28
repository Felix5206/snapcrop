#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SnapCrop 本地服务器（零依赖，仅使用 Python 标准库）

作用：以 http:// 方式打开项目，避免 file:// 协议下部分浏览器对
      Canvas / 剪贴板 / 本地存储的限制，同时便于截图与调试。

用法：
    python serve.py            # 默认 http://127.0.0.1:5173
    python serve.py 8080       # 指定端口（被占用时自动顺延）
    python serve.py 8080 0     # 指定端口且不自动打开浏览器

打包为 Windows 可执行程序后（PyInstaller 单文件）资源目录取 sys._MEIPASS，
index.html / assets / config 需通过 --add-data 一并打包，运行时无需 Python 环境。
"""
import http.server
import os
import socket
import socketserver
import sys
import threading
import webbrowser
from functools import partial

DEFAULT_PORT = 5173
HOST = "127.0.0.1"


def resource_dir():
    """资源目录：源码运行时为脚本所在目录；打包为 exe 时为解包临时目录。"""
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # 精简日志
        sys.stderr.write("  %s\n" % (fmt % args))


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """多线程服务：浏览器并行请求多个静态资源时不会互相阻塞"""
    daemon_threads = True
    allow_reuse_address = True


def pick_port(preferred):
    """端口被占用时自动顺延，避免直接抛错退出"""
    for port in range(preferred, preferred + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((HOST, port))
                return port
            except OSError:
                continue
    raise OSError("端口 %d ~ %d 均被占用" % (preferred, preferred + 19))


def open_browser(url):
    try:
        webbrowser.open(url)
    except Exception:
        pass


def _init_console():
    """控制台编码容错：输出被重定向到管道时，Windows 默认 GBK 可能无法编码某些字符，
    设为 errors='replace' 可避免直接抛 UnicodeEncodeError 导致闪退。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass


def main():
    _init_console()
    port = DEFAULT_PORT
    auto_open = True
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print("端口参数无效（%s），已回退到默认端口 %d" % (sys.argv[1], DEFAULT_PORT))
            port = DEFAULT_PORT
    if len(sys.argv) > 2 and sys.argv[2] in ("0", "no", "off"):
        auto_open = False

    handler = partial(Handler, directory=resource_dir())
    port = pick_port(port)
    with ThreadingServer((HOST, port), handler) as httpd:
        url = "http://%s:%d/index.html" % (HOST, port)
        print("简裁 SnapCrop 正在运行：%s" % url, flush=True)
        print("关闭本窗口或按 Ctrl+C 即可停止服务。", flush=True)
        if auto_open:
            # 延迟打开，避免服务尚未就绪时浏览器抢先访问
            threading.Timer(0.6, lambda: open_browser(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
