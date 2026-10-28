#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SnapCrop 本地开发服务器（零依赖，仅使用 Python 标准库）

作用：以 http:// 方式打开项目，避免 file:// 协议下部分浏览器对
      Canvas / 剪贴板 / 本地存储的限制，同时便于截图与调试。

用法：
    python serve.py            # 默认 http://127.0.0.1:5173
    python serve.py 8080       # 指定端口
"""
import http.server
import socketserver
import sys
import webbrowser
from functools import partial

DEFAULT_PORT = 5173
DIRECTORY = __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0]


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # 精简日志
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    handler = partial(Handler, directory=DIRECTORY)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
        url = "http://127.0.0.1:%d/index.html" % port
        print("SnapCrop is running at %s  (Ctrl+C 停止)" % url)
        try:
            webbrowser.open(url)
        except Exception:
            pass
        httpd.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已停止")
